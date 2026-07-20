#!/usr/bin/env node
/*
 * Tests de non-régression sur les 3 fonctions financières critiques de
 * ZEEV CARS : computeCommission, computeEligibilite, computeLatePenalty.
 *
 * Pourquoi ce fichier existe (audit critique du 10/07/2026, point #9) :
 * l'application est un unique fichier HTML/CSS/JS sans build ni suite de
 * tests. Une régression sur ces 3 fonctions serait un bug financier ou
 * juridique silencieux (commission mal calculée, éligibilité erronée,
 * pénalité de retard fausse), pas juste un bug visuel.
 *
 * Comment ça marche : ce script EXTRAIT le code réel de index.html au
 * moment de l'exécution (pas une copie figée) et l'exécute tel quel — donc
 * si quelqu'un modifie ces fonctions dans index.html sans mettre ce fichier
 * à jour, le test continue de tester le VRAI code, pas une version périmée.
 *
 * Exécution locale : node tests/critical-functions.test.js
 * Exécution automatique : voir .github/workflows/tests.yml (à chaque push)
 */

const fs = require("fs");
const path = require("path");

const INDEX_HTML_PATH = path.join(__dirname, "..", "index.html");

function extractFn(name, src) {
  const re = new RegExp("(async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = re.exec(src);
  if (!m) throw new Error(`Fonction "${name}" introuvable dans index.html — a-t-elle été renommée ?`);
  const start = m.index;
  let i = src.indexOf("{", start);
  let depth = 1;
  i++;
  while (depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(start, i);
}

function extractConst(name, src) {
  const re = new RegExp("const\\s+" + name + "\\s*=\\s*\\{");
  const m = re.exec(src);
  if (!m) throw new Error(`Constante "${name}" introuvable dans index.html.`);
  const start = m.index;
  let i = src.indexOf("{", start);
  let depth = 1;
  i++;
  while (depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(start, i) + ";";
}

const html = fs.readFileSync(INDEX_HTML_PATH, "utf-8");
const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!scriptMatch) throw new Error("Aucun bloc <script> trouvé dans index.html.");
const script = scriptMatch[1];

// Environnement minimal requis par les fonctions extraites — pas de DOM,
// state.contracts suffit toujours à satisfaire tauxConcession() sans jamais
// retomber sur le repli document.getElementById (évite une dépendance jsdom
// pour ce test, volontairement gardé simple et rapide).
global.state = { contracts: {} };
global.document = { getElementById: () => null };

const code = [
  extractConst("LATE_PENALTY_CONFIG", script),
  extractFn("slugFor", script),
  extractFn("tauxConcession", script),
  extractFn("computeCommission", script),
  extractFn("computeCommissionSimulation", script),
  extractFn("computeLatePenalty", script),
  extractFn("computeEligibilite", script),
].join("\n\n");

// eslint-disable-next-line no-eval
eval(code + `
global.tauxConcession = tauxConcession;
global.computeCommission = computeCommission;
global.computeCommissionSimulation = computeCommissionSimulation;
global.computeLatePenalty = computeLatePenalty;
global.computeEligibilite = computeEligibilite;
global.LATE_PENALTY_CONFIG = LATE_PENALTY_CONFIG;
`);

// ---------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------
let passed = 0, failed = 0;
function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      attendu : ${JSON.stringify(expected)}`);
    console.log(`      obtenu  : ${JSON.stringify(actual)}`);
  }
}

console.log("computeEligibilite()");
assertEqual(
  "non livré -> ATTENTE_LIVRAISON",
  computeEligibilite({ statut_livraison: "EN_COMMANDE", pv_signe: "NON_SIGNE" }),
  "ATTENTE_LIVRAISON"
);
assertEqual(
  "livré mais PV non signé -> ATTENTE_PV",
  computeEligibilite({ statut_livraison: "LIVRE", pv_signe: "NON_SIGNE" }),
  "ATTENTE_PV"
);
assertEqual(
  "livré + PV signé -> FACTURABLE",
  computeEligibilite({ statut_livraison: "LIVRE", pv_signe: "SIGNE" }),
  "FACTURABLE"
);

console.log("\ncomputeCommission()");
state.contracts.TEST_CONCESSION = { rate: 3, locked: true };
assertEqual(
  "non éligible -> commission nulle même si valeur renseignée",
  computeCommission({ concession: "TEST_CONCESSION", statut_livraison: "EN_COMMANDE", pv_signe: "NON_SIGNE", valeur_vente_ht: 20000 }),
  0
);
assertEqual(
  "éligible, valeur 20000€, taux 3% -> 600€",
  computeCommission({ concession: "TEST_CONCESSION", statut_livraison: "LIVRE", pv_signe: "SIGNE", valeur_vente_ht: 20000 }),
  600
);
assertEqual(
  "éligible mais valeur_vente_ht absente -> 0",
  computeCommission({ concession: "TEST_CONCESSION", statut_livraison: "LIVRE", pv_signe: "SIGNE", valeur_vente_ht: null }),
  0
);

console.log("\ncomputeLatePenalty()");
assertEqual(
  "pas encore facturé -> null",
  computeLatePenalty({ statut_facturation: "NON_FACTURE", date_facture: "" }),
  null
);
assertEqual(
  "déjà payé -> null (pas de pénalité même si en retard)",
  computeLatePenalty({ statut_facturation: "FACTURE", date_facture: "2020-01-01", statut_paiement: "PAYE" }),
  null
);
{
  // Facture très ancienne (2020), donc largement en retard, permet un test
  // stable dans le temps (n'expire jamais, contrairement à "hier").
  const concession = "TEST_CONCESSION";
  const v = {
    concession, statut_facturation: "FACTURE", date_facture: "2020-01-01",
    statut_paiement: "NON_PAYE", statut_livraison: "LIVRE", pv_signe: "SIGNE",
    valeur_vente_ht: 20000,
  };
  const result = computeLatePenalty(v);
  const ok = result && result.joursRetard > 2000 && result.indemnite === 40 && result.interet > 0;
  if (ok) { passed++; console.log("  ✓ facture ancienne largement en retard -> pénalité calculée avec indemnité 40€"); }
  else { failed++; console.log("  ✗ facture ancienne largement en retard -> résultat inattendu:", JSON.stringify(result)); }
}

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
if (failed > 0) process.exit(1);
