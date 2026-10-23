#!/usr/bin/env node
/**
 * Mise à jour de la BDD Cyberpunk TCG pour TCG Arena.
 *
 * Source : API publique de la base officielle (https://cyberpunktcg.com/cards,
 * fournie par Netdeck.gg) : api.netdeck.gg/api/cards/cyberpunk
 *
 *  1. Récupère toutes les cartes de l'API, page par page.
 *  2. Garde uniquement les impressions anglaises.
 *  3. Télécharge les images manquantes (ou modifiées sur le site officiel) dans Images/Cards/<SET_CODE>/.
 *  4. Génère Cyberpunk-TCG-Cards.json au format TCG Arena (une entrée par impression).
 *  5. Anciens IDs : un ancien ID absent devient un alias { id, aliasOf } vers la carte correspondante
 *     (retrouvée par le nom). Les anciennes cartes sans équivalent sont gardées telles quelles.
 *  6. Rapport détaillé dans Scripts/update-report.md
 *
 * Emplacement : Scripts/Update.js (les chemins partent de la racine du repo)
 * Usage       : node Scripts/Update.js
 * Dépendances : aucune (Node 18+)
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ─────────────────────────────── Configuration ───────────────────────────────

const CONFIG = {
    apiUrl: 'https://api.netdeck.gg/api/cards/cyberpunk',
    repoRoot: path.resolve(process.env.REPO_ROOT || path.join(__dirname, '..')),

    // fichiers du jeu, relatifs à la racine du repo
    cardsFile: 'Cyberpunk-TCG-Cards.json',
    imagesDir: 'Images/Cards',               // Images/Cards/<SET_CODE>/<numéro>.webp

    // fichiers internes, relatifs à la racine du repo
    printingsFile: 'Scripts/printings.json',  // id attribué à chaque impression + image source déjà téléchargée
    reportFile: 'Scripts/update-report.md',

    // URL GitHub Pages du repo. Dans la GitHub Action elle est déduite du nom du repo ;
    // en local, c'est cette valeur qui sert (ou la variable d'environnement PAGES_BASE_URL).
    fallbackPagesUrl: 'https://valcur.github.io/TCG-Arena-Cyberpunk',

    language: 'en',
    pageSize: 60,
    pauseBetweenPagesMs: 500,
    concurrency: 4,
    timeoutMs: 30_000,
    retries: 4,
    minRatioVsPrevious: 0.5,                 // refuse d'écrire si on perd plus de la moitié des cartes (FORCE=1 pour forcer)
    userAgent: 'TCG-Arena-Cyberpunk-updater (+https://tcg-arena.fr)',
};

/**
 * Alias forcés à la main pour les anciens IDs : 'ANCIEN_ID': 'NOUVEL_ID'.
 * Sans entrée ici, le script retrouve tout seul la carte par son nom.
 */
const ALIAS_OVERRIDES = {
};

const COLOR_LABELS = {
    Red: '🟥 Red',
    Yellow: '🟨 Yellow',
    Blue: '🟦 Blue',
    Green: '🟩 Green',
};

// Ancien format : tableau d'anciens IDs sur la carte (remplacé par les entrées aliasOf, converti automatiquement)
const LEGACY_ALIAS_ARRAY_FIELD = 'aliases';

const PAGES_URL = trimSlash(process.env.PAGES_BASE_URL || pagesUrlFromRepository() || CONFIG.fallbackPagesUrl);

// ─────────────────────────────── Rapport ───────────────────────────────

const issues = []; // { level: 'error' | 'warning', category, id, message }

function report(level, category, id, message) {
    issues.push({ level, category, id, message });
}

class FatalError extends Error { }

// ─────────────────────────────── Utilitaires ───────────────────────────────

function trimSlash(s) { return String(s).replace(/\/+$/, ''); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rel(...p) { return path.join(CONFIG.repoRoot, ...p); }

function pagesUrlFromRepository() {
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository || !repository.includes('/')) return null;
    const [owner, name] = repository.split('/');
    const host = `${owner.toLowerCase()}.github.io`;
    return name.toLowerCase() === host ? `https://${host}` : `https://${host}/${name}`;
}

async function readJsonIfExists(file, fallback) {
    try {
        return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, ''));
    } catch (e) {
        if (e.code !== 'ENOENT') throw new FatalError(`${path.relative(CONFIG.repoRoot, file)} illisible : ${e.message}`);
        return fallback;
    }
}

async function writeFileAtomic(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, file);
}

/** N'écrit que si le contenu change (évite les commits inutiles) */
async function writeIfChanged(file, content) {
    try {
        if (await fsp.readFile(file, 'utf8') === content) return false;
    } catch { }
    await writeFileAtomic(file, content);
    return true;
}

async function runPool(items, limit, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const item = items[i++];
            await worker(item);
        }
    });
    await Promise.all(runners);
}

function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

function sortedObject(obj) {
    return Object.fromEntries(Object.keys(obj).sort(naturalCompare).map(k => [k, obj[k]]));
}

function toNumberOrNull(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
}

/** Pour l'id et le nom de fichier : "β005a" → "b005a", le reste en [a-z0-9-] */
function idPart(s) {
    const cleaned = String(s || '')
        .replace(/[βΒ]/g, 'b')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned || 'x';
}

function setCodeOf(printing) {
    return String(printing.set?.code || 'unknown').replace(/[^A-Za-z0-9_-]+/g, '-');
}

/** Nom au format TCG Arena : "V - Streetkid" */
function cardName(card) {
    if (card.subname) return `${card.name} - ${card.subname}`;
    const name = card.canonical_name || card.display_name || card.name || '?';
    return name.replace(/\s*[—–]\s*/g, ' - ').trim();
}

/** Nom comparable : sans accents, ponctuation ni casse */
function normName(s) {
    return String(s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[’'`´"]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

function isWebp(buf) {
    return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}

// ─────────────────────────────── Réseau ───────────────────────────────

/** fetch avec retries sur erreurs réseau / 429 / 5xx ; les autres codes sont rendus à l'appelant */
async function fetchWithRetry(url, headers = {}) {
    let lastError = 'erreur inconnue';
    for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': CONFIG.userAgent, ...headers },
                signal: AbortSignal.timeout(CONFIG.timeoutMs),
            });
            if (res.status !== 429 && res.status < 500) return res;
            try { await res.body?.cancel(); } catch { }
            lastError = `HTTP ${res.status}`;
        } catch (e) {
            lastError = e.name === 'TimeoutError' ? `timeout après ${CONFIG.timeoutMs / 1000}s` : (e.cause?.code || e.message);
        }
        if (attempt < CONFIG.retries) await sleep(1000 * 2 ** (attempt - 1));
    }
    throw new Error(lastError);
}

async function fetchPage(offset) {
    const url = `${CONFIG.apiUrl}?limit=${CONFIG.pageSize}&offset=${offset}`;
    const res = await fetchWithRetry(url, { Accept: 'application/json' });
    if (!res.ok) throw new FatalError(`API : HTTP ${res.status} (offset ${offset})`);
    const data = await res.json();
    if (!data || !Array.isArray(data.items)) throw new FatalError(`API : réponse inattendue (offset ${offset}), champ "items" absent`);
    return data.items;
}

/** Les liens d'images signés expirent après quelques minutes : téléchargement juste après la page */
async function downloadImage(url, destination) {
    const res = await fetchWithRetry(url);
    if (!res.ok) {
        try { await res.body?.cancel(); } catch { }
        const error = new Error(`HTTP ${res.status}`);
        error.status = res.status;
        throw error;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isWebp(buf)) throw new Error('le fichier reçu n\'est pas un WebP');
    await writeFileAtomic(destination, buf);
}

// ─────────────────────────────── Cartes ───────────────────────────────

function englishPrintings(card) {
    return (card.printings || []).filter(p => p?.id && p.language === CONFIG.language);
}

function renderName(printing) {
    const source = printing.source_image_url || String(printing.image_url || '').split('?')[0];
    return source ? source.split('/').pop() : null;
}

/**
 * Id stable d'une impression : "<SET_CODE>-<numéro>" (ex: welcometonightcityretail-005a).
 * Une fois attribué, il est mémorisé dans Scripts/printings.json et ne change plus.
 */
function assignId(printing, registry, usedIds) {
    if (registry[printing.id]?.id) return registry[printing.id].id;
    let id = `${setCodeOf(printing)}-${idPart(printing.collector_number)}`;
    if (printing.finish) id += `-${idPart(printing.finish)}`;
    if (usedIds.has(id)) id += `-${idPart(printing.id).slice(0, 8)}`;
    return id;
}

function imageLocation(printing, id) {
    const setCode = setCodeOf(printing);
    const fileName = `${id.startsWith(setCode + '-') ? id.slice(setCode.length + 1) : id}.webp`;
    return {
        file: rel(CONFIG.imagesDir, setCode, fileName),
        url: `${PAGES_URL}/${CONFIG.imagesDir}/${encodeURIComponent(setCode)}/${encodeURIComponent(fileName)}`,
    };
}

function buildCardEntry(card, printing, id, image) {
    const name = cardName(card);
    const type = card.card_type || 'Unknown';
    const cost = toNumberOrNull(card.cost) ?? 0; // Legends sans coût → 0
    const entry = {
        id,
        isToken: false,
        face: {
            front: { name, type, cost, image, isHorizontal: false },
        },
        name,
        type,
        cost,
    };
    if (card.color) entry['RAM Color'] = COLOR_LABELS[card.color] || card.color;
    const ram = toNumberOrNull(card.ram);
    if (ram !== null) entry.RAM = ram;
    const power = toNumberOrNull(card.power);
    if (power !== null) entry.Power = power;
    if (printing.rarity || card.rarity) entry.Rarity = printing.rarity || card.rarity;
    if (printing.set?.name) entry.Set = printing.set.name;
    if (Array.isArray(card.classifications) && card.classifications.length) entry.Tags = [...card.classifications];
    if (Array.isArray(card.keywords) && card.keywords.length) entry.Keywords = [...card.keywords];
    return entry;
}

// ─────────────────────────────── Anciens IDs → alias ───────────────────────────────

/** Carte officielle portant le même nom (tolère quelques fautes de frappe), sinon null */
function findByName(names, nameIndex) {
    const wanted = [...new Set(names.filter(n => typeof n === 'string' && n.trim()).map(normName))];
    if (!wanted.length) return null;

    for (const n of wanted) {
        const hits = nameIndex.filter(c => c.name === n);
        if (hits.length === 1) return { target: hits[0].mainId, how: 'même nom' };
    }

    let best = null;
    let tie = false;
    for (const c of nameIndex) {
        for (const n of wanted) {
            const distance = levenshtein(n, c.name);
            const limit = Math.min(3, Math.floor(Math.max(n.length, c.name.length) * 0.1));
            if (distance > limit) continue;
            if (!best || distance < best.distance) { best = { c, distance }; tie = false; }
            else if (distance === best.distance && c.mainId !== best.c.mainId) tie = true;
        }
    }
    if (best && !tie) return { target: best.c.mainId, how: `nom proche "${best.c.displayName}"`, approx: true };
    return null; // pas de devinette au-delà : un mauvais alias est pire qu'aucun alias
}

/**
 * Pour chaque ancien ID absent des cartes officielles :
 *  1. ALIAS_OVERRIDES   2. alias déjà existant (aliasOf, ou ancien tableau "aliases")
 *  3. carte au même nom → alias vers son impression principale (Retail en général)
 *  Sinon l'ancienne carte est gardée telle quelle.
 *  Retourne les alias (chaînes aplaties : le moteur ne suit qu'un niveau) et les anciennes cartes gardées.
 */
function resolveOldIds(previousCards, realCards, nameIndex) {
    const realIds = new Set(Object.keys(realCards));
    const raw = {};
    const kept = {};

    // ancien format : tableau "aliases" sur une carte → alias vers cette carte
    for (const [id, e] of Object.entries(previousCards)) {
        for (const oldId of Array.isArray(e?.[LEGACY_ALIAS_ARRAY_FIELD]) ? e[LEGACY_ALIAS_ARRAY_FIELD] : []) {
            if (!realIds.has(oldId) && !previousCards[oldId]) raw[oldId] = { target: e.id || id, how: 'alias existant', carried: true };
        }
    }

    for (const oldId of new Set([...Object.keys(previousCards), ...Object.keys(ALIAS_OVERRIDES)])) {
        if (realIds.has(oldId)) continue;
        const prev = previousCards[oldId];
        if (ALIAS_OVERRIDES[oldId]) { raw[oldId] = { target: ALIAS_OVERRIDES[oldId], how: 'manuel' }; continue; }
        if (prev?.aliasOf) { raw[oldId] = { target: prev.aliasOf, how: 'alias existant', carried: true }; continue; }
        if (!prev) continue;
        const m = findByName([prev.name, prev.face?.front?.name], nameIndex);
        if (m) raw[oldId] = m;
        else kept[oldId] = prev;
    }

    const aliases = {};
    for (const [oldId, a] of Object.entries(raw)) {
        let target = a.target;
        let how = a.how;
        const seen = new Set([oldId]);
        while (!realIds.has(target) && raw[target] && !seen.has(target)) {
            seen.add(target);
            target = raw[target].target;
        }
        if (!realIds.has(target)) {
            // la carte visée a disparu : on la retrouve par son ancien nom
            const old = previousCards[target];
            const m = old && !old.aliasOf ? findByName([old.name, old.face?.front?.name], nameIndex) : null;
            if (m) { target = m.target; how = `cible "${a.target}" disparue, retrouvée par le nom`; }
        }
        if (realIds.has(target)) aliases[oldId] = { ...a, target, how };
        else if (previousCards[oldId] && !previousCards[oldId].aliasOf) kept[oldId] = previousCards[oldId];
        else report('warning', 'Alias impossible : la carte cible n\'existe plus', oldId, `cible "${a.target}" (${a.how})`);
    }
    return { aliases, kept };
}

// ─────────────────────────────── Rapport ───────────────────────────────

function buildReport(summary) {
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    const v = summary.verification;
    const lines = [];
    lines.push('# Mise à jour des cartes Cyberpunk TCG', '');
    lines.push('| | |', '|---|---|');
    lines.push(`| Cartes officielles | ${summary.cardCount} |`);
    lines.push(`| Impressions EN dans ${CONFIG.cardsFile} | ${summary.printingCount} |`);
    lines.push(`| Alias (anciens IDs) | ${summary.aliasCount} |`);
    lines.push(`| Anciennes cartes gardées telles quelles | ${summary.keptCount} |`);
    lines.push(`| ❌ Erreurs | ${errors.length} |`);
    lines.push(`| ⚠️ Avertissements | ${warnings.length} |`, '');

    if (summary.fatal) lines.push('## 💥 Erreur bloquante', '', summary.fatal, '', `${CONFIG.cardsFile} n'a PAS été modifié.`, '');

    if (v) {
        lines.push('## ✅ Vérification des anciennes cartes', '');
        lines.push(`- Anciennes entrées (cartes et alias) : **${v.total}**`);
        lines.push(`- Présentes avec le même ID : **${v.direct}**`);
        lines.push(`- Redirigées par alias : **${v.aliased}**`);
        lines.push(`- Gardées telles quelles (sans équivalent officiel) : **${v.kept}**`);
        lines.push(`- Perdues : **${v.lost}**`, '');
    }

    if (summary.keptList?.length) {
        lines.push(`## 📦 Anciennes cartes sans équivalent officiel (${summary.keptList.length})`, '');
        summary.keptList.forEach(([id, name]) => lines.push(`- \`${id}\` — ${name} (ajoute un alias dans ALIAS_OVERRIDES si tu connais la nouvelle carte)`));
        lines.push('');
    }

    if (summary.gaps?.length) {
        lines.push('## 🔢 Numéros absents de l\'API (pour info)', '');
        summary.gaps.forEach(([set, nums]) => lines.push(`- \`${set}\` : ${nums.join(', ')}`));
        lines.push('');
    }

    const section = (title, list) => {
        if (!list.length) return;
        lines.push(`## ${title} (${list.length})`, '');
        const byCat = new Map();
        for (const i of list) byCat.set(i.category, [...(byCat.get(i.category) || []), i]);
        for (const [cat, items] of byCat) {
            lines.push(`### ${cat} — ${items.length}`, '');
            items.forEach(i => lines.push(`- \`${i.id}\` — ${i.message}`));
            lines.push('');
        }
    };
    section('❌ Erreurs', errors);
    section('⚠️ Avertissements', warnings);

    if (summary.added.length) {
        lines.push(`## ➕ Nouvelles impressions (${summary.added.length})`, '');
        summary.added.forEach(([id, name]) => lines.push(`- \`${id}\` — ${name}`));
        lines.push('');
    }
    return lines.join('\n');
}

/** Numéros manquants dans la suite de chaque set (cartes absentes de l'API ou non anglaises) */
function numberingGaps(realCards, printingOf) {
    const bySet = new Map();
    for (const id of Object.keys(realCards)) {
        const p = printingOf.get(id);
        const m = /(\d+)/.exec(String(p.collector_number || ''));
        if (!m) continue;
        const set = setCodeOf(p);
        if (!bySet.has(set)) bySet.set(set, new Set());
        bySet.get(set).add(Number(m[1]));
    }
    const gaps = [];
    for (const [set, nums] of [...bySet].sort((a, b) => naturalCompare(a[0], b[0]))) {
        const sorted = [...nums].sort((a, b) => a - b);
        const missing = [];
        for (let n = 1; n < sorted[sorted.length - 1]; n++) if (!nums.has(n)) missing.push(String(n).padStart(3, '0'));
        if (missing.length) gaps.push([set, missing]);
    }
    return gaps;
}

function printIssuesToConsole() {
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    for (const [icon, list] of [['❌', errors], ['⚠️ ', warnings]]) {
        const byCat = new Map();
        list.forEach(i => byCat.set(i.category, [...(byCat.get(i.category) || []), i]));
        for (const [cat, items] of byCat) {
            console.log(`\n${icon} ${cat} (${items.length})`);
            items.slice(0, 30).forEach(i => console.log(`   - ${i.id} : ${i.message}`));
            if (items.length > 30) console.log(`   … et ${items.length - 30} autre(s), voir le rapport`);
        }
    }
    if (!errors.length && !warnings.length) console.log('\n✨ Aucune erreur, aucun avertissement.');
}

// ─────────────────────────────── Main ───────────────────────────────

async function main() {
    const summary = {
        cardCount: 0, printingCount: 0, aliasCount: 0, keptCount: 0,
        added: [], keptList: [], gaps: [], verification: null, fatal: null,
    };

    try {
        const cardsPath = rel(CONFIG.cardsFile);
        const printingsPath = rel(CONFIG.printingsFile);
        const previousCards = await readJsonIfExists(cardsPath, {});
        const registry = await readJsonIfExists(printingsPath, {});
        console.log(`📋 ${CONFIG.apiUrl}`);
        console.log(`🖼️  Images : ${PAGES_URL}/${CONFIG.imagesDir}/...\n`);

        const realCards = {};
        const printingOf = new Map();   // id → impression
        const officialCards = new Map(); // id de carte API → { card, mainId, mainPrintingId }
        const seenPrintings = new Set();
        const usedIds = new Set(Object.values(registry).map(r => r?.id).filter(Boolean));
        const previousGenerated = Object.keys(previousCards).filter(id => usedIds.has(id)).length;
        let downloaded = 0, refreshed = 0;

        // ── 1. Cartes de l'API, page par page ──
        for (let offset = 0; ; offset += CONFIG.pageSize) {
            if (offset > 20_000) throw new FatalError('Pagination anormalement longue, arrêt par sécurité.');
            const items = await fetchPage(offset);
            if (!items.length) break;

            const tasks = [];
            for (const card of items) {
                if (!card || officialCards.has(card.id)) continue;
                const printings = englishPrintings(card).filter(p => !seenPrintings.has(p.id));
                if (!printings.length) continue;
                const main = printings.find(p => p.id === card.selected_printing_id) || printings[0];
                officialCards.set(card.id, { card, mainId: null, mainPrintingId: main.id });

                for (const printing of printings) {
                    seenPrintings.add(printing.id);
                    const id = assignId(printing, registry, usedIds);
                    usedIds.add(id);
                    const { file, url } = imageLocation(printing, id);
                    const render = renderName(printing);
                    const previousRender = registry[printing.id]?.image || null;
                    const exists = fs.existsSync(file);
                    tasks.push({
                        card, printing, id, file, url, render, previousRender, exists,
                        // absente, ou image officielle modifiée depuis le dernier passage
                        download: !exists || Boolean(render && previousRender && render !== previousRender),
                        signedUrl: printing.image_url, error: null,
                    });
                }
            }

            // ── 2. Images de la page ──
            const toDownload = tasks.filter(t => t.download);
            const tryDownload = async (t, url) => {
                try {
                    if (!url) throw new Error('pas d\'URL d\'image');
                    await downloadImage(url, t.file);
                    if (t.exists) refreshed++; else downloaded++;
                    t.exists = true;
                    t.error = null;
                } catch (e) {
                    t.error = e;
                }
            };
            await runPool(toDownload, CONFIG.concurrency, t => tryDownload(t, t.signedUrl));

            // liens expirés (403) : on redemande la page pour avoir des liens neufs, puis second essai
            const expired = toDownload.filter(t => t.error?.status === 403);
            if (expired.length) {
                const fresh = new Map();
                try {
                    for (const card of await fetchPage(offset)) for (const p of englishPrintings(card)) fresh.set(p.id, p.image_url);
                } catch (e) {
                    report('warning', 'Page non redemandée après liens expirés', `offset ${offset}`, e.message);
                }
                await runPool(expired, CONFIG.concurrency, t => tryDownload(t, fresh.get(t.printing.id)));
            }

            // ── 3. Entrées de la page ──
            for (const t of tasks) {
                if (t.error) {
                    report('warning', t.exists ? 'Image non mise à jour (ancienne gardée, retentée au prochain run)' : 'Impressions reportées : image indisponible (retentées au prochain run)',
                        t.id, `${cardName(t.card)} — ${t.error.message}`);
                }
                if (!t.exists) continue;
                registry[t.printing.id] = { id: t.id, image: t.error ? t.previousRender : (t.render || t.previousRender) };
                realCards[t.id] = buildCardEntry(t.card, t.printing, t.id, t.url);
                printingOf.set(t.id, t.printing);
                const info = officialCards.get(t.card.id);
                if (t.printing.id === info.mainPrintingId || !info.mainId) info.mainId = t.id;
            }

            console.log(`📥 offset ${offset} : ${items.length} cartes, ${toDownload.length} image(s) à télécharger`);
            if (items.length < CONFIG.pageSize) break;
            await sleep(CONFIG.pauseBetweenPagesMs);
        }

        const realIds = Object.keys(realCards);
        if (!realIds.length) throw new FatalError('Aucune carte exploitable');
        if (previousGenerated && realIds.length < previousGenerated * CONFIG.minRatioVsPrevious && process.env.FORCE !== '1') {
            throw new FatalError(`Seulement ${realIds.length} impressions contre ${previousGenerated} dans le ${CONFIG.cardsFile} actuel. ` +
                'Probable problème côté API. Relancer avec FORCE=1 pour écraser quand même.');
        }

        // ── 4. Anciens IDs → alias vers la carte officielle ──
        const nameIndex = [...officialCards.values()].filter(c => c.mainId)
            .map(c => ({ mainId: c.mainId, name: normName(cardName(c.card)), displayName: cardName(c.card) }));
        const { aliases, kept } = resolveOldIds(previousCards, realCards, nameIndex);

        for (const [oldId, a] of Object.entries(aliases)) {
            if (!a.carried && a.approx) report('warning', 'Alias approximatifs (vérifie que c\'est la bonne carte)', oldId, `${previousCards[oldId]?.name || ''} → ${a.target} (${a.how})`);
        }

        // ── 5. Écriture : cartes officielles, puis alias, puis anciennes cartes gardées ──
        const out = { ...sortedObject(realCards) };
        for (const oldId of Object.keys(aliases).sort(naturalCompare)) out[oldId] = { id: oldId, aliasOf: aliases[oldId].target };
        for (const [oldId, entry] of Object.entries(kept)) out[oldId] = entry;

        const previousAliasArrays = Object.values(previousCards)
            .flatMap(e => Array.isArray(e?.[LEGACY_ALIAS_ARRAY_FIELD]) ? e[LEGACY_ALIAS_ARRAY_FIELD] : []);
        const oldUniverse = [...new Set([...Object.keys(previousCards), ...previousAliasArrays])];
        summary.verification = {
            total: oldUniverse.length,
            direct: oldUniverse.filter(id => realCards[id]).length,
            aliased: oldUniverse.filter(id => out[id]?.aliasOf).length,
            kept: oldUniverse.filter(id => kept[id]).length,
            lost: oldUniverse.filter(id => !out[id]).length,
        };
        summary.cardCount = officialCards.size;
        summary.printingCount = realIds.length;
        summary.aliasCount = Object.keys(aliases).length;
        summary.keptCount = Object.keys(kept).length;
        summary.keptList = Object.entries(kept).map(([id, e]) => [id, e.name || '?']);
        summary.added = realIds.filter(id => !(id in previousCards)).map(id => [id, realCards[id].name]);
        summary.gaps = numberingGaps(realCards, printingOf);

        await writeIfChanged(cardsPath, JSON.stringify(out, null, 2) + '\n');
        await writeIfChanged(printingsPath, JSON.stringify(sortedObject(registry), null, 2) + '\n');

        const v = summary.verification;
        console.log(`\n💾 ${CONFIG.cardsFile} : ${summary.cardCount} cartes, ${summary.printingCount} impressions EN (${summary.added.length} nouvelles) + ${summary.aliasCount} alias + ${summary.keptCount} ancienne(s) carte(s) gardée(s)`);
        console.log(`🖼️  Images : ${downloaded} téléchargée(s), ${refreshed} mise(s) à jour`);
        if (v.total) console.log(`✅ Anciennes entrées : ${v.total} → ${v.direct} identiques, ${v.aliased} via alias, ${v.kept} gardées telles quelles, ${v.lost} perdue(s)`);
    } catch (e) {
        summary.fatal = e instanceof FatalError ? e.message : `Erreur inattendue : ${e.stack || e.message}`;
        console.error(`\n💥 ${summary.fatal}`);
    }

    printIssuesToConsole();
    const md = buildReport(summary);
    try {
        await writeIfChanged(rel(CONFIG.reportFile), md + '\n');
        if (process.env.GITHUB_STEP_SUMMARY) await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, md + '\n');
    } catch (e) {
        console.error('Impossible d\'écrire le rapport :', e.message);
    }
    console.log(`\n📄 Rapport : ${CONFIG.reportFile}`);
    if (summary.fatal) process.exitCode = 1;
    return summary;
}

module.exports = { main };

if (require.main === module) main();
