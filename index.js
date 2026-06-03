// ═══════════════════════════════════════════════════════
// BOT COMMERCIAL UNIVERSEL — Node.js + Telegram
// Version propre : sans email, sans fidélité
// Produits dynamiques et personnalisables
// ═══════════════════════════════════════════════════════

const express = require("express");
const OpenAI  = require("openai");
const axios   = require("axios");
const cors    = require("cors");
const { google } = require("googleapis");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ─────────────────────────────────────────
// CONNEXIONS
// ─────────────────────────────────────────
const openai        = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GAS_URL       = process.env.GAS_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API  = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const RENDER_URL    = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID;

const USERS_AUTORISES = [
  process.env.TELEGRAM_USER_ID_1,
  process.env.TELEGRAM_USER_ID_2,
].filter(Boolean);

// ─────────────────────────────────────────
// BASE DE DONNÉES EN MÉMOIRE
// ─────────────────────────────────────────
let db = {
  produits:         [],  // { id, nom, variante, categorie, caracteristiques, prix_achat, prix_vente, prix_revendeur, stock_initial, stock, photo_url, champs_custom, cree_le }
  clients:          [],  // { id, nom, telephone, note, nb_achats, ca_total, derniere_visite, cree_le }
  ventes:           [],  // { id, client_nom, produit_nom, produit_variante, quantite, prix_vente, montant_total, marge_totale, date }
  charges:          [],  // { id, label, montant, categorie, produit_lie, date }
  historique_stock: [],
  agenda:           [],  // { id, titre, date, chatId, rappels_envoyes }
  relances:         [],  // { id, client_nom, client_tel, note, date, chatId, rappels_envoyes, statut }
  livraisons:       [],  // { id, client_nom, client_tel, produit, note, date, chatId, rappels_envoyes, statut }
};

let sessions = {};
let rappelsDejaEnvoyes = {};

// ─────────────────────────────────────────
// UTILITAIRES
// ─────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function calculerMarge(achat, vente) {
  const marge = vente - achat;
  const taux  = achat > 0 ? ((marge / achat) * 100).toFixed(1) : 0;
  return { marge: parseFloat(marge.toFixed(0)), taux: parseFloat(taux) };
}

function getAlertes()  { return db.produits.filter(p => p.stock <= 5 && p.stock > 0); }
function getRuptures() { return db.produits.filter(p => p.stock === 0); }

function getStats() {
  const ca            = db.ventes.reduce((s, v) => s + v.montant_total, 0);
  const cout_achats   = db.ventes.reduce((s, v) => s + (v.prix_achat_unitaire || 0) * v.quantite, 0);
  const total_charges = db.charges.reduce((s, c) => s + c.montant, 0);
  const marge_brute   = db.ventes.reduce((s, v) => s + v.marge_totale, 0);
  const benefice_net  = marge_brute - total_charges;
  return { ca, marge_brute, total_charges, benefice_net, nb_produits: db.produits.length, nb_clients: db.clients.length, nb_ventes: db.ventes.length };
}

// ─────────────────────────────────────────
// GOOGLE CALENDAR
// ─────────────────────────────────────────
let calendarAuth = null;

function initGoogleCalendar() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    console.log("⚠️ Google Calendar non configuré");
    return;
  }
  try {
    calendarAuth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    console.log("📅 Google Calendar configuré");
  } catch (err) {
    console.error("❌ Google Calendar :", err.message);
  }
}

async function creerEventGoogleCalendar(titre, dateISO) {
  if (!calendarAuth || !CALENDAR_ID) return null;
  try {
    const calendar = google.calendar({ version: "v3", auth: calendarAuth });
    const d        = new Date(dateISO);
    const fin      = new Date(d.getTime() + 60 * 60 * 1000);
    const res = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: titre,
        start:   { dateTime: d.toISOString(),   timeZone: "Africa/Porto-Novo" },
        end:     { dateTime: fin.toISOString(), timeZone: "Africa/Porto-Novo" },
      },
    });
    return res.data.id;
  } catch (err) {
    console.error("❌ Google Calendar insert:", err.message);
    return null;
  }
}

async function supprimerEventGoogleCalendar(googleEventId) {
  if (!calendarAuth || !CALENDAR_ID || !googleEventId) return;
  try {
    const calendar = google.calendar({ version: "v3", auth: calendarAuth });
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: googleEventId });
  } catch (err) {
    console.error("❌ Google Calendar delete:", err.message);
  }
}

// ─────────────────────────────────────────
// PHOTO — Téléchargement & Upload Imgur
// ─────────────────────────────────────────
async function telechargerEtUploaderPhoto(fileId, nomProduit) {
  try {
    const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const filePath = fileRes.data.result.file_path;
    const imgBuffer = await axios.get(
      `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`,
      { responseType: "arraybuffer" }
    );
    const base64 = Buffer.from(imgBuffer.data).toString("base64");
    const imgurRes = await axios.post(
      "https://api.imgur.com/3/image",
      { image: base64, type: "base64", name: nomProduit },
      { headers: { Authorization: `Client-ID ${process.env.IMGUR_CLIENT_ID || "546c25a59c58ad7"}` } }
    );
    if (imgurRes.data?.data?.link) return imgurRes.data.data.link;
    return null;
  } catch (err) {
    console.error("❌ Upload photo:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────
// GOOGLE SHEETS — Communication
// ─────────────────────────────────────────
async function envoyerVersSheets(action, data) {
  if (!GAS_URL) return;
  try {
    await axios.post(GAS_URL, { action, ...data });
  } catch (err) {
    console.error("❌ Sheets POST:", err.message);
  }
}

async function chargerDepuisSheets(force = false) {
  if (!GAS_URL) return;
  try {
    const res  = await axios.get(GAS_URL + "?action=charger_tout");
    const data = res.data;

    // Sauvegarder les rappels déjà envoyés avant de recharger
    db.agenda.forEach(e    => { if (e.id) rappelsDejaEnvoyes[e.id]         = e.rappels_envoyes || []; });
    db.relances.forEach(r  => { if (r.id) rappelsDejaEnvoyes['r_'+r.id]    = r.rappels_envoyes || []; });
    db.livraisons.forEach(l => { if (l.id) rappelsDejaEnvoyes['l_'+l.id]  = l.rappels_envoyes || []; });

    db.produits   = [];
    db.clients    = [];
    db.ventes     = [];
    db.charges    = [];
    db.agenda     = [];
    db.relances   = [];
    db.livraisons = [];

    if (data.produits && data.produits.length > 0) {
      db.produits = data.produits.map(p => ({
        id:               p["ID"]               || p.id               || genId(),
        nom:              p["Nom"]              || p.nom              || "",
        variante:         p["Variante"]         || p.variante         || "",   // remplace "Couleur"
        categorie:        p["Catégorie"]        || p.categorie        || "",
        caracteristiques: p["Caractéristiques"] || p.caracteristiques || "",
        prix_achat:       parseFloat(p["Prix Achat"]   || p.prix_achat)   || 0,
        prix_vente:       parseFloat(p["Prix Vente"]   || p.prix_vente)   || 0,
        prix_revendeur:   parseFloat(p["Prix Revendeur"] || p.prix_revendeur) || null,
        stock_initial:    parseInt(p["Stock Initial"] || p.stock_initial) || 0,
        stock:            parseInt(p["Stock Actuel"]  || p.stock)         || 0,
        photo_url:        p["Photo URL"]        || p.photo_url        || null,
        cree_le:          p["Date"]             || p.cree_le          || new Date().toISOString(),
      }));
      console.log(`✅ ${db.produits.length} produit(s) chargé(s)`);
    }

    if (data.clients && data.clients.length > 0) {
      db.clients = data.clients.map(c => ({
        id:              c["ID"]          || c.id              || genId(),
        nom:             c["Nom"]         || c.nom             || "",
        telephone:       String(c["Téléphone"] || c.telephone  || ""),
        note:            c["Note"]        || c.note            || "",
        nb_achats:       parseInt(c["Nb Achats"] || c.nb_achats) || 0,
        ca_total:        parseFloat(c["CA Total"]  || c.ca_total)  || 0,
        cree_le:         c["Date"]        || c.cree_le         || new Date().toISOString(),
      }));
      console.log(`✅ ${db.clients.length} client(s) chargé(s)`);
    }

    if (data.ventes && data.ventes.length > 0) {
      db.ventes = data.ventes.map(v => ({
        id:              v["ID"]            || v.id              || genId(),
        client_nom:      v["Client"]        || v.client_nom      || "",
        produit_nom:     v["Produit"]       || v.produit_nom     || "",
        quantite:        parseInt(v["Quantité"]    || v.quantite)     || 1,
        prix_vente:      parseFloat(v["Prix Vente Unit."] || v.prix_vente) || 0,
        montant_total:   parseFloat(v["Montant Total"] || v.montant_total) || 0,
        marge_totale:    parseFloat(v["Marge Totale"]  || v.marge_totale)  || 0,
        reduction:       parseFloat(v["Réduction"]     || v.reduction)     || 0,
        prix_achat_unitaire: parseFloat(v["Prix Achat Unit."] || v.prix_achat_unitaire) || 0,
        produit_variante: v["Variante"] || v.produit_variante || "",
        date: (() => {
          const d = v["Date"] || v.date || "";
          if (!d) return new Date().toISOString();
          if (typeof d === 'string' && d.includes('/')) {
            const [datePart, timePart] = d.split(' ');
            const [jour, mois, annee] = datePart.split('/');
            return new Date(`${annee}-${mois}-${jour}T${timePart || '00:00:00'}`).toISOString();
          }
          return new Date(d).toISOString();
        })(),
      }));
      console.log(`✅ ${db.ventes.length} vente(s) chargée(s)`);
    }

    if (data.charges && data.charges.length > 0) {
      db.charges = data.charges.map(c => ({
        id:          c["ID"]         || c.id          || genId(),
        label:       c["Libellé"]    || c.label       || "",
        montant:     parseFloat(c["Montant"]   || c.montant)   || 0,
        categorie:   c["Catégorie"]  || c.categorie   || "",
        produit_lie: c["Produit Lié"] || c.produit_lie || null,
        date: (() => {
          const d = c["Date"] || c.date || "";
          if (!d) return new Date().toISOString();
          if (typeof d === 'string' && d.includes('/')) {
            const [datePart, timePart] = d.split(' ');
            const [jour, mois, annee] = datePart.split('/');
            return new Date(`${annee}-${mois}-${jour}T${timePart || '00:00:00'}`).toISOString();
          }
          return new Date(d).toISOString();
        })(),
      }));
      console.log(`✅ ${db.charges.length} charge(s) chargée(s)`);
    }

    if (data.agenda && data.agenda.length > 0) {
      db.agenda = data.agenda.map(e => {
        const id = e["ID"] || e.id || genId();
        return {
          id,
          titre:           e["Titre"]    || e.titre    || "",
          date:            e["Date ISO"] || e.date_iso || e.date || new Date().toISOString(),
          chatId:          e["Chat ID"]  || e.chatId   || USERS_AUTORISES[0] || null,
          rappels_envoyes: rappelsDejaEnvoyes[id] || [],
          googleEventId:   null,
        };
      });
      console.log(`✅ ${db.agenda.length} événement(s) chargé(s)`);
    }

    if (data.relances && data.relances.length > 0) {
      db.relances = data.relances.map(r => {
        const id = r["ID"] || r.id || genId();
        return {
          id,
          client_nom:      r["Client"]      || r.client_nom  || "",
          client_tel:      r["Téléphone"]   || r.client_tel  || "",
          note:            r["Note"]        || r.note        || "",
          date:            r["Date Relance"] || r.date       || new Date().toISOString(),
          chatId:          r["Chat ID"]     || r.chatId      || USERS_AUTORISES[0] || null,
          rappels_envoyes: rappelsDejaEnvoyes['r_'+id] || [],
        };
      });
      console.log(`✅ ${db.relances.length} relance(s) chargée(s)`);
    }

    if (data.livraisons && data.livraisons.length > 0) {
      db.livraisons = data.livraisons.map(l => {
        const id = l["ID"] || l.id || genId();
        return {
          id,
          client_nom:      l["Client"]       || l.client_nom  || "",
          client_tel:      l["Téléphone"]    || l.client_tel  || "",
          produit:         l["Produit"]      || l.produit     || "",
          note:            l["Note"]         || l.note        || "",
          date:            l["Date Livraison"] || l.date      || new Date().toISOString(),
          chatId:          l["Chat ID"]      || l.chatId      || USERS_AUTORISES[0] || null,
          rappels_envoyes: rappelsDejaEnvoyes['l_'+id] || [],
        };
      });
      console.log(`✅ ${db.livraisons.length} livraison(s) chargée(s)`);
    }

    console.log("✅ Données rechargées depuis Google Sheets !");
  } catch (err) {
    console.error("❌ Erreur chargement Sheets :", err.message);
    console.log("⚠️ Démarrage à vide");
  }
}

// ─────────────────────────────────────────
// GESTION CLIENTS
// ─────────────────────────────────────────
function trouverOuCreerClient(info) {
  if (!info || info === "Anonyme") return null;
  const recherche = info.trim().toLowerCase();
  const estUnProduit = db.produits.some(p => p.nom.toLowerCase() === recherche);
  if (estUnProduit) return null;

  let client = db.clients.find(c =>
    c.nom.toLowerCase().includes(recherche) ||
    (c.telephone && c.telephone.replace(/\s/g, "").includes(recherche))
  );
  if (!client) {
    client = {
      id: genId(), nom: info.trim(), telephone: "",
      note: "Créé via vente", nb_achats: 0, ca_total: 0,
      derniere_visite: new Date().toISOString(), cree_le: new Date().toISOString(),
    };
    db.clients.push(client);
    envoyerVersSheets("nouveau_client", {
      nom: client.nom, telephone: "", note: client.note,
      date: new Date().toLocaleString("fr-FR", { timeZone: "Africa/Porto-Novo" })
    });
  }
  return client;
}

// ─────────────────────────────────────────
// ENREGISTRER UNE VENTE
// ─────────────────────────────────────────
async function enregistrerVenteComplete(produitNom, qte, clientInfo, prixVenteOverride = null) {
  // Chercher par "Nom Variante" exact d'abord, puis par nom seul
  let produit = db.produits.find(p => {
    const nomAvecVariante = p.variante ? (p.nom + " " + p.variante).toLowerCase() : p.nom.toLowerCase();
    return nomAvecVariante === produitNom.toLowerCase();
  });
  if (!produit) {
    const variantes = db.produits.filter(p => p.nom.toLowerCase().includes(produitNom.toLowerCase()));
    if (variantes.length > 0) produit = variantes.sort((a, b) => b.stock - a.stock)[0];
  }
  if (!produit)          return { erreur: `Produit "${produitNom}" introuvable` };
  if (produit.stock < qte) return { erreur: `Stock insuffisant pour ${produit.nom} (dispo: ${produit.stock})` };

  const client     = clientInfo ? trouverOuCreerClient(clientInfo) : null;
  const prixVente  = prixVenteOverride || produit.prix_vente;
  const avant      = produit.stock;
  produit.stock   -= qte;

  await envoyerVersSheets("mouvement_stock", {
    produit:     produit.nom,
    variante:    produit.variante || "",
    operation:   "remove",
    quantite:    qte,
    stock_avant: avant,
    stock_apres: produit.stock,
    note:        "Vente",
    date:        new Date().toLocaleString("fr-FR", { timeZone: "Africa/Porto-Novo" })
  });

  const montant_total = parseFloat((prixVente * qte).toFixed(0));
  const marge_totale  = parseFloat(((prixVente - produit.prix_achat) * qte).toFixed(0));

  const vente = {
    id:                  genId(),
    client_id:           client ? client.id : null,
    client_nom:          client ? client.nom : "Anonyme",
    produit_id:          produit.id,
    produit_nom:         produit.nom,
    produit_variante:    produit.variante || "",
    produit_photo_url:   produit.photo_url || null,
    prix_achat_unitaire: produit.prix_achat,
    prix_vente_unitaire: prixVente,
    is_revendeur:        prixVenteOverride !== null && prixVenteOverride === produit.prix_revendeur,
    quantite:            qte,
    montant_total,
    marge_totale,
    date:                new Date().toISOString(),
  };

  db.ventes.unshift(vente);
  db.historique_stock.unshift({
    id: genId(), produit_id: produit.id, produit_nom: produit.nom,
    operation: "remove", quantite: qte, stock_avant: avant, stock_apres: produit.stock,
    note: `Vente — ${vente.client_nom}`, date: new Date().toISOString(),
  });

  if (client) {
    client.nb_achats     += 1;
    client.ca_total      += montant_total;
    client.derniere_visite = new Date().toISOString();
  }

  envoyerVersSheets("nouvelle_vente", {
    client:       vente.client_nom,
    produit:      produit.nom,
    quantite:     qte,
    prix_vente:   prixVente,
    montant_total,
    marge_totale,
    reduction:    0,
    type_vente:   vente.is_revendeur ? "Revendeur" : "Normal",
    date:         new Date().toLocaleString("fr-FR"),
  });

  return { vente, produit, client, alerte: produit.stock <= 5 };
}

// ─────────────────────────────────────────
// FINALISER UNE VENTE
// ─────────────────────────────────────────
async function finaliserVente(chatId, session, clientNom) {
  const panier = session.data.panier && session.data.panier.length > 0 ? session.data.panier : null;

  // ── PANIER MULTI-ARTICLES ──
  if (panier && panier.length > 1) {
    session.etape = null; session.data = {};
    let repGlobal = `✅ *Vente enregistrée !*\n👤 ${clientNom || "Anonyme"}\n\n`;
    let totalGlobal = 0;
    for (const item of panier) {
      const result = await enregistrerVenteComplete(item.produit.nom, item.quantite, clientNom, item.prix_unitaire);
      if (!result.erreur) {
        totalGlobal += item.total;
        repGlobal   += `🛒 *${item.produit.nom}${item.produit.variante ? ' — '+item.produit.variante : ''}* x${item.quantite} = ${item.total} FCFA\n`;
      } else {
        repGlobal += `❌ ${result.erreur}\n`;
      }
    }
    repGlobal += `\n💰 *Total: ${totalGlobal} FCFA*`;
    return sendMessage(chatId, repGlobal, { reply_markup: menuVentes() });
  }

  // ── ARTICLE UNIQUE ──
  if (panier && panier.length === 1) {
    session.data.produit      = panier[0].produit;
    session.data.quantite     = panier[0].quantite;
    session.data.prixOverride = panier[0].prix_unitaire;
  }

  let prixOverride = session.data.prixOverride || null;
  if (!prixOverride && session.data.reduction_manuelle && session.data.reduction_manuelle > 0) {
    const prixBase = session.data.produit.prix_vente * session.data.quantite;
    if (session.data.reduction_montant_exact) {
      prixOverride = Math.round((prixBase - session.data.reduction_montant_exact) / session.data.quantite);
    } else {
      prixOverride = Math.round(session.data.produit.prix_vente * (1 - session.data.reduction_manuelle / 100));
    }
  }

  const result = await enregistrerVenteComplete(session.data.produit.nom, session.data.quantite, clientNom, prixOverride);
  session.etape = null; session.data = {};

  if (result.erreur) return sendMessage(chatId, `❌ ${result.erreur}`, { reply_markup: menuVentes() });

  // Alerte stock critique
  if (result.produit.stock <= 2 && result.produit.stock > 0) {
    await sendMessage(chatId, `🚨 *STOCK CRITIQUE !*\n📦 ${result.produit.nom}${result.produit.variante ? ' — '+result.produit.variante : ''}\n⚠️ Il ne reste que *${result.produit.stock}* unité(s) !`);
  } else if (result.produit.stock === 0) {
    await sendMessage(chatId, `🔴 *RUPTURE DE STOCK !*\n📦 ${result.produit.nom}${result.produit.variante ? ' — '+result.produit.variante : ''}\n❌ Plus aucune unité disponible !`);
  }

  let rep = `✅ *Vente enregistrée !*\n🛒 ${result.vente.produit_nom}${result.vente.produit_variante ? ' — '+result.vente.produit_variante : ''} x${result.vente.quantite}\n👤 ${result.vente.client_nom}\n💰 *${result.vente.montant_total} FCFA*\n📈 Marge: ${result.vente.marge_totale} FCFA\n📦 Restant: ${result.produit.stock}`;
  if (result.alerte) rep += `\n\n⚠️ *Stock bas !* → ${result.produit.stock} restant(s)`;
  return sendMessage(chatId, rep, { reply_markup: menuVentes() });
}

// ─────────────────────────────────────────
// RAPPELS & PING
// ─────────────────────────────────────────
function formatDateFR(dateISO) {
  const d   = new Date(dateISO);
  const str = d.toLocaleString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function calculerRappels(dateEvent) {
  const d     = new Date(dateEvent);
  const matin = new Date(d);
  matin.setHours(8, 0, 0, 0);
  if (matin >= d) matin.setDate(matin.getDate() - 1);
  return [
    { type: "1j",    time: new Date(d.getTime() - 24 * 60 * 60 * 1000), label: "⏰ Rappel J-1 — demain !" },
    { type: "matin", time: matin,                                         label: "🌅 Rappel matin" },
    { type: "1h",    time: new Date(d.getTime() - 60 * 60 * 1000),       label: "⏱️ Rappel dans 1h" },
    { type: "30min", time: new Date(d.getTime() - 30 * 60 * 1000),       label: "🔔 Dans 30 min !" },
    { type: "heure", time: new Date(d.getTime()),                         label: "🚨 C'est maintenant !" },
  ];
}

function demarrerRappels() {
  setInterval(async () => {
    const maintenant = new Date();

    for (const event of db.agenda) {
      if (new Date(event.date) < maintenant) continue;
      const rappels = calculerRappels(event.date);
      for (const rappel of rappels) {
        if (event.rappels_envoyes.includes(rappel.type)) continue;
        const diff = rappel.time.getTime() - maintenant.getTime();
        if (diff >= -90000 && diff <= 90000) {
          await sendMessage(event.chatId, `${rappel.label}\n\n📅 *${event.titre}*\n🕐 ${formatDateFR(event.date)}`);
          event.rappels_envoyes.push(rappel.type);
        }
      }
    }
    db.agenda = db.agenda.filter(e => new Date(e.date).getTime() > Date.now() - 24 * 60 * 60 * 1000);

    for (const relance of db.relances) {
      if (relance.statut === "✅ Fait" || new Date(relance.date) < maintenant) continue;
      for (const rappel of calculerRappels(relance.date)) {
        if (relance.rappels_envoyes.includes(rappel.type)) continue;
        const diff = rappel.time.getTime() - maintenant.getTime();
        if (diff >= -90000 && diff <= 90000) {
          await sendMessage(relance.chatId, `${rappel.label} — Relance client\n\n📞 *${relance.client_nom}*${relance.client_tel ? "\n📱 " + relance.client_tel : ""}${relance.note ? "\n📝 " + relance.note : ""}\n🕐 ${formatDateFR(relance.date)}`);
          relance.rappels_envoyes.push(rappel.type);
        }
      }
    }

    for (const livraison of db.livraisons) {
      if (livraison.statut === "✅ Livré" || new Date(livraison.date) < maintenant) continue;
      for (const rappel of calculerRappels(livraison.date)) {
        if (livraison.rappels_envoyes.includes(rappel.type)) continue;
        const diff = rappel.time.getTime() - maintenant.getTime();
        if (diff >= -90000 && diff <= 90000) {
          await sendMessage(livraison.chatId, `${rappel.label} — Livraison\n\n🚚 *${livraison.client_nom}*${livraison.client_tel ? "\n📱 " + livraison.client_tel : ""}${livraison.produit ? "\n🛒 " + livraison.produit : ""}${livraison.note ? "\n📝 " + livraison.note : ""}\n🕐 ${formatDateFR(livraison.date)}`);
          livraison.rappels_envoyes.push(rappel.type);
        }
      }
    }
  }, 30000);

  setInterval(async () => {
    try { await axios.get(RENDER_URL + "/ping"); } catch (err) {}
  }, 10 * 60 * 1000);

  console.log("🔔 Rappels démarrés (30s) + auto-ping 10min");
}

// ─────────────────────────────────────────
// TELEGRAM — Fonctions de base
// ─────────────────────────────────────────
async function sendMessage(chatId, text, options = {}) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, parse_mode: "Markdown", ...options });
  } catch (err) { console.error("Erreur sendMessage:", err.message); }
}

// ─────────────────────────────────────────
// MENUS CLAVIER
// ─────────────────────────────────────────
function menuPrincipal() {
  return { keyboard: [["📦 Produits", "👥 Clients"], ["💰 Ventes", "📊 Charges"], ["📈 Stats", "🚨 Alertes"], ["📅 Agenda"], ["🤖 IA"]], resize_keyboard: true };
}
function menuProduits() {
  return { keyboard: [["➕ Ajouter produit"], ["📋 Voir stock", "🔄 Restock"], ["✏️ Modifier produit", "🗑️ Supprimer produit"], ["🏠 Menu"]], resize_keyboard: true };
}
function menuClients() {
  return { keyboard: [["➕ Ajouter client", "🔍 Rechercher client"], ["📋 Voir clients"], ["📞 Clients à relancer", "🚚 Commandes à livrer"], ["✏️ Modifier client", "🗑️ Supprimer client"], ["🏠 Menu"]], resize_keyboard: true };
}
function menuVentes() {
  return { keyboard: [["➕ Vente rapide", "📝 Vente texte"], ["📋 Voir ventes"], ["✏️ Modifier vente", "🗑️ Supprimer vente"], ["🏠 Menu"]], resize_keyboard: true };
}
function menuAgenda() {
  return { keyboard: [["➕ Ajouter événement"], ["📋 Voir agenda", "🔍 Agenda du jour"], ["✏️ Modifier événement", "🗑️ Supprimer événement"], ["🏠 Menu"]], resize_keyboard: true };
}
function menuIA() {
  return { keyboard: [["📊 Analyse rentabilité"], ["🚨 Produits à restock"], ["💡 Conseils CA"], ["❓ Question libre"], ["🏠 Menu"]], resize_keyboard: true };
}

// ─────────────────────────────────────────
// WEBHOOK TELEGRAM
// ─────────────────────────────────────────
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;

  const msg    = update.message;
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id.toString();
  const text   = msg.text || "";
  const photo  = msg.photo;

  if (USERS_AUTORISES.length > 0 && !USERS_AUTORISES.includes(userId))
    return sendMessage(chatId, "⛔ Accès non autorisé.");

  if (!sessions[chatId]) sessions[chatId] = { etape: null, data: {} };
  const session = sessions[chatId];

  if (text === "❌ Annuler" || text === "🏠 Menu") {
    session.etape = null; session.data = {};
    return sendMessage(chatId, `🏠 *Menu principal*`, { reply_markup: menuPrincipal() });
  }

  if (text === "/start") {
    session.etape = null; session.data = {};
    return sendMessage(chatId, `👋 Bonjour ! Je suis votre *Bot Commercial* 🛍️\n\nChoisissez une option :`, { reply_markup: menuPrincipal() });
  }

  // ══ PRODUITS ══════════════════════════════════════════════════════════════

  if (text === "📦 Produits") return sendMessage(chatId, `📦 *PRODUITS*`, { reply_markup: menuProduits() });

  if (text === "📋 Voir stock") {
    await chargerDepuisSheets();
    if (db.produits.length === 0) return sendMessage(chatId, `📦 Aucun produit.`, { reply_markup: menuProduits() });
    let m = `📦 *STOCK ACTUEL*\n\n`;
    const modeles = {};
    db.produits.forEach(p => {
      if (!modeles[p.nom]) modeles[p.nom] = [];
      modeles[p.nom].push(p);
    });
    Object.entries(modeles).forEach(([nom, variantes]) => {
      const stockTotal = variantes.reduce((s, v) => s + v.stock, 0);
      const s = stockTotal === 0 ? "🔴" : stockTotal <= 5 ? "🟡" : "🟢";
      m += `${s} *${nom}*\n`;
      m += `   💵 ${variantes[0].prix_achat} → 💰 ${variantes[0].prix_vente} FCFA\n`;
      if (variantes[0].caracteristiques) m += `   🔬 ${variantes[0].caracteristiques}\n`;
      if (variantes[0].categorie) m += `   🏷️ ${variantes[0].categorie}\n`;
      variantes.forEach(v => {
        const sv    = v.stock === 0 ? "🔴" : v.stock <= 5 ? "🟡" : "🟢";
        const label = v.variante ? `🏷️ ${v.variante}` : "📦 Sans variante";
        m += `   ${sv} ${label} : *${v.stock}* / ${v.stock_initial} (init)\n`;
      });
      m += `\n`;
    });
    return sendMessage(chatId, m, { reply_markup: menuProduits() });
  }

  if (text === "🔄 Restock") {
    if (db.produits.length === 0) return sendMessage(chatId, `📦 Aucun produit.`, { reply_markup: menuProduits() });
    session.etape = "restock_modele"; session.data = {};
    const nomsUniques = [...new Set(db.produits.map(p => p.nom))];
    const b = nomsUniques.map(nom => [`📦 ${nom}`]); b.push(["❌ Annuler"]);
    return sendMessage(chatId, `🔄 Choisissez le modèle :`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "restock_modele") {
    const nom      = text.replace("📦 ", "").trim();
    const variantes = db.produits.filter(p => p.nom === nom);
    if (variantes.length === 0) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuProduits() });
    if (variantes.length === 1 && !variantes[0].variante) {
      session.data.produit = variantes[0]; session.etape = "restock_quantite";
      return sendMessage(chatId, `🔄 *${nom}* — Stock actuel: ${variantes[0].stock}\n\nAjouter combien ?`, { reply_markup: { keyboard: [["5"], ["10"], ["20"], ["50"], ["❌ Annuler"]], resize_keyboard: true } });
    }
    session.data.nomModele = nom; session.etape = "restock_variante";
    const b = variantes.map(v => [`🏷️ ${v.variante} (${v.stock} dispo)`]); b.push(["❌ Annuler"]);
    return sendMessage(chatId, `🏷️ Variante :`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "restock_variante") {
    const variante = text.replace("🏷️ ", "").replace(/ \(\d+ dispo\)$/, '').trim();
    const p = db.produits.find(p => p.nom === session.data.nomModele && p.variante === variante);
    if (!p) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuProduits() });
    session.data.produit = p; session.etape = "restock_quantite";
    return sendMessage(chatId, `🔄 *${p.nom} — ${p.variante}* — Stock: ${p.stock}\n\nAjouter combien ?`, { reply_markup: { keyboard: [["5"], ["10"], ["20"], ["50"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "restock_quantite") {
    const qte = parseInt(text.replace(/[^0-9]/g, ""));
    if (isNaN(qte) || qte <= 0) return sendMessage(chatId, `⚠️ Quantité invalide.`);
    const p     = session.data.produit;
    const avant = p.stock;
    p.stock    += qte;
    await envoyerVersSheets("mouvement_stock", {
      produit: p.nom, variante: p.variante || "", operation: "add",
      quantite: qte, stock_avant: avant, stock_apres: p.stock,
      note: "Restock", date: new Date().toLocaleString("fr-FR", { timeZone: "Africa/Porto-Novo" })
    });
    session.etape = null; session.data = {};
    return sendMessage(chatId, `✅ *Restock effectué !*\n📦 ${p.nom}${p.variante ? ' — '+p.variante : ''}\n➕ +${qte} | Stock : *${p.stock}*`, { reply_markup: menuProduits() });
  }

  // ── AJOUTER PRODUIT ──────────────────────────────────────────────────────

  if (text === "➕ Ajouter produit") {
    session.etape = "produit_nom"; session.data = {};
    return sendMessage(chatId, `📦 *Nouveau produit*\n\nNom du produit :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "produit_nom") {
    session.data.nom  = text.trim();
    session.etape     = "produit_variante";
    return sendMessage(chatId, `🏷️ *Variante* (ex: Rouge, Grande taille, 500ml, XL…)\n_Ou "skip" si pas de variante_`, { reply_markup: { keyboard: [["skip"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "produit_variante") {
    session.data.variante = text === "skip" ? "" : text.trim();
    session.etape         = "produit_categorie";
    return sendMessage(chatId, `🏷️ *Catégorie* (ou "skip") :\n_Ex: Électronique, Vêtement, Alimentaire…_`, { reply_markup: { keyboard: [["skip"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "produit_categorie") {
    session.data.categorie = text === "skip" ? "" : text.trim();
    session.etape          = "produit_caracteristiques";
    return sendMessage(chatId, `🔬 *Caractéristiques* (ou "skip") :\n_Ex: 100% coton, 4K, sans sucre…_`, { reply_markup: { keyboard: [["skip"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "produit_caracteristiques") {
    session.data.caracteristiques = text === "skip" ? "" : text.trim();
    session.etape                 = "produit_achat";
    return sendMessage(chatId, `💵 *Prix d'achat* (FCFA) :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "produit_achat") {
    const pa = parseFloat(text.replace(/[^0-9.]/g, ""));
    if (isNaN(pa) || pa <= 0) return sendMessage(chatId, `⚠️ Prix invalide.`);
    session.data.prix_achat = pa;
    session.etape           = "produit_vente";
    return sendMessage(chatId, `💰 *Prix de vente* (FCFA) :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "produit_vente") {
    const pv = parseFloat(text.replace(/[^0-9.]/g, ""));
    if (isNaN(pv) || pv <= 0) return sendMessage(chatId, `⚠️ Prix invalide.`);
    session.data.prix_vente = pv;
    session.etape           = "produit_prix_revendeur";
    return sendMessage(chatId, `🤝 *Prix revendeur* (FCFA) ou "skip" :`, { reply_markup: { keyboard: [["skip"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "produit_prix_revendeur") {
    if (text === "skip") {
      session.data.prix_revendeur = null;
    } else {
      const pr = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(pr) || pr <= 0) return sendMessage(chatId, `⚠️ Prix invalide ou "skip" :`);
      session.data.prix_revendeur = pr;
    }
    session.etape = "produit_stock";
    return sendMessage(chatId, `🗃️ *Stock initial* (quantité) :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "produit_stock") {
    const st = parseInt(text.replace(/[^0-9]/g, ""));
    if (isNaN(st) || st < 0) return sendMessage(chatId, `⚠️ Quantité invalide.`);
    session.data.stock = st;
    session.etape      = "produit_photo";
    return sendMessage(chatId, `📸 *Photo* (optionnel)\nEnvoyez une photo ou tapez "skip"`, { reply_markup: { keyboard: [["skip"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "produit_photo") {
    let photo_url = null;
    if (msg.photo && msg.photo.length > 0) {
      const photo_id = msg.photo[msg.photo.length - 1].file_id;
      await sendMessage(chatId, `⏳ Upload photo en cours...`);
      photo_url = await telechargerEtUploaderPhoto(photo_id, session.data.nom);
    }

    const p = {
      id:               genId(),
      nom:              session.data.nom,
      variante:         session.data.variante || "",
      categorie:        session.data.categorie || "",
      caracteristiques: session.data.caracteristiques || "",
      prix_achat:       session.data.prix_achat,
      prix_vente:       session.data.prix_vente,
      prix_revendeur:   session.data.prix_revendeur || null,
      stock_initial:    session.data.stock,
      stock:            session.data.stock,
      photo_url,
      cree_le:          new Date().toISOString(),
    };
    db.produits.push(p);

    const { marge, taux } = calculerMarge(p.prix_achat, p.prix_vente);
    const dateStr = new Date().toLocaleString("fr-FR", { timeZone: "Africa/Porto-Novo" });

    await envoyerVersSheets("nouveau_produit", {
      nom: p.nom, variante: p.variante, categorie: p.categorie,
      caracteristiques: p.caracteristiques,
      prix_achat: p.prix_achat, prix_vente: p.prix_vente,
      prix_revendeur: p.prix_revendeur || "",
      stock_initial: p.stock_initial, stock: p.stock,
      photo_url: p.photo_url || "", date: dateStr,
    });

    session.etape = null; session.data = {};

    let recap = `✅ *Produit enregistré !*\n\n📦 *${p.nom}*`;
    if (p.variante)         recap += ` — ${p.variante}`;
    recap += `\n`;
    if (p.categorie)        recap += `🏷️ ${p.categorie}\n`;
    if (p.caracteristiques) recap += `🔬 ${p.caracteristiques}\n`;
    recap += `💵 Achat: ${p.prix_achat} FCFA | Vente: ${p.prix_vente} FCFA\n`;
    recap += `📈 Marge: *${marge} FCFA (${taux}%)*\n`;
    recap += `🗃️ Stock: *${p.stock}*\n`;
    if (p.photo_url) recap += `📸 Photo ✅\n`;
    recap += `\n➕ Pour ajouter une autre variante, appuyez sur *Ajouter produit*`;

    return sendMessage(chatId, recap, { reply_markup: menuProduits() });
  }

  // ── SUPPRIMER PRODUIT ────────────────────────────────────────────────────

  if (text === "🗑️ Supprimer produit") {
    await chargerDepuisSheets();
    if (db.produits.length === 0) return sendMessage(chatId, `📦 Aucun produit.`, { reply_markup: menuProduits() });
    const nomsUniques = [...new Set(db.produits.map(p => p.nom))];
    const b = nomsUniques.map(nom => [`🗑️ ${nom}`]); b.push(["❌ Annuler"]);
    session.etape = "supprimer_produit_modele"; session.data = {};
    return sendMessage(chatId, `🗑️ *Supprimer quel modèle ?*`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "supprimer_produit_modele") {
    const nom      = text.replace("🗑️ ", "").trim();
    const variantes = db.produits.filter(p => p.nom === nom);
    if (variantes.length === 0) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuProduits() });
    if (variantes.length === 1) {
      session.data.nomModele   = nom;
      session.data.varianteCible = variantes[0].variante || null;
      session.etape             = "supprimer_produit_confirm";
      return sendMessage(chatId, `⚠️ Supprimer *${nom}${variantes[0].variante ? ' — '+variantes[0].variante : ''}* ?`, { reply_markup: { keyboard: [["✅ Confirmer suppression"], ["❌ Annuler"]], resize_keyboard: true } });
    }
    session.data.nomModele = nom; session.etape = "supprimer_produit_variante";
    const b = variantes.map(v => [`🏷️ ${v.variante || "Sans variante"}`]);
    b.push(["🗑️ Supprimer toutes les variantes"], ["❌ Annuler"]);
    return sendMessage(chatId, `🏷️ Quelle variante ?`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "supprimer_produit_variante") {
    if (text === "🗑️ Supprimer toutes les variantes") {
      session.data.tout = true; session.etape = "supprimer_produit_confirm";
      return sendMessage(chatId, `⚠️ Supprimer *TOUTES* les variantes de *${session.data.nomModele}* ?`, { reply_markup: { keyboard: [["✅ Confirmer suppression"], ["❌ Annuler"]], resize_keyboard: true } });
    }
    const variante = text.replace("🏷️ ", "").trim();
    session.data.varianteCible = variante === "Sans variante" ? "" : variante;
    session.etape              = "supprimer_produit_confirm";
    return sendMessage(chatId, `⚠️ Supprimer *${session.data.nomModele} — ${variante}* ?`, { reply_markup: { keyboard: [["✅ Confirmer suppression"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "supprimer_produit_confirm") {
    if (text !== "✅ Confirmer suppression") {
      session.etape = null; session.data = {};
      return sendMessage(chatId, `❌ Annulé.`, { reply_markup: menuProduits() });
    }
    const nom = session.data.nomModele;
    db.produits = db.produits.filter(p => {
      if (p.nom !== nom) return true;
      if (session.data.tout) return false;
      return p.variante !== (session.data.varianteCible || "");
    });
    await envoyerVersSheets("supprimer_produit", {
      nom, variante: session.data.varianteCible || "", tout: session.data.tout || false
    });
    session.etape = null; session.data = {};
    return sendMessage(chatId, `✅ *${nom}* supprimé.`, { reply_markup: menuProduits() });
  }

  // ── MODIFIER PRODUIT ─────────────────────────────────────────────────────

  if (text === "✏️ Modifier produit") {
    await chargerDepuisSheets();
    if (db.produits.length === 0) return sendMessage(chatId, `📦 Aucun produit.`, { reply_markup: menuProduits() });
    const nomsUniques = [...new Set(db.produits.map(p => p.nom))];
    const b = nomsUniques.map(nom => [`✏️ ${nom}`]); b.push(["❌ Annuler"]);
    session.etape = "modifier_produit_modele"; session.data = {};
    return sendMessage(chatId, `✏️ *Modifier quel modèle ?*`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "modifier_produit_modele") {
    const nom      = text.replace("✏️ ", "").trim();
    const variantes = db.produits.filter(p => p.nom === nom);
    if (variantes.length === 0) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuProduits() });
    if (variantes.length > 1) {
      session.data.nomModele = nom; session.etape = "modifier_produit_variante";
      const b = variantes.map(v => [`✏️ ${v.variante || "Sans variante"}`]); b.push(["❌ Annuler"]);
      return sendMessage(chatId, `🏷️ Quelle variante ?`, { reply_markup: { keyboard: b, resize_keyboard: true } });
    }
    session.data.produit = variantes[0]; session.etape = "modifier_produit_champ";
    const p = variantes[0];
    return sendMessage(chatId,
      `✏️ *${p.nom}*${p.variante ? ' — '+p.variante : ''}\n💵 Achat: ${p.prix_achat} | Vente: ${p.prix_vente} | Stock: ${p.stock}\n\nQue modifier ?`,
      { reply_markup: { keyboard: [["💵 Prix achat", "💰 Prix vente"], ["📦 Stock", "🏷️ Variante"], ["🔬 Caractéristiques", "🏷️ Catégorie"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "modifier_produit_variante") {
    const variante = text.replace("✏️ ", "").trim();
    const p = db.produits.find(p => p.nom === session.data.nomModele && (p.variante || "Sans variante") === variante);
    if (!p) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuProduits() });
    session.data.produit = p; session.etape = "modifier_produit_champ";
    return sendMessage(chatId,
      `✏️ *${p.nom} — ${p.variante}*\n💵 Achat: ${p.prix_achat} | Vente: ${p.prix_vente} | Stock: ${p.stock}\n\nQue modifier ?`,
      { reply_markup: { keyboard: [["💵 Prix achat", "💰 Prix vente"], ["📦 Stock", "🏷️ Variante"], ["🔬 Caractéristiques", "🏷️ Catégorie"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "modifier_produit_champ") {
    const cm = {
      "💵 Prix achat": "prix_achat", "💰 Prix vente": "prix_vente",
      "📦 Stock": "stock", "🏷️ Variante": "variante",
      "🔬 Caractéristiques": "caracteristiques", "🏷️ Catégorie": "categorie"
    };
    if (!cm[text]) { session.etape = null; session.data = {}; return sendMessage(chatId, `❌ Annulé.`, { reply_markup: menuProduits() }); }
    session.data.champ = cm[text]; session.etape = "modifier_produit_valeur";
    return sendMessage(chatId, `✏️ Nouvelle valeur :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "modifier_produit_valeur") {
    const p    = session.data.produit;
    const champ = session.data.champ;
    const val  = ['prix_achat', 'prix_vente', 'stock'].includes(champ) ? parseFloat(text.replace(/[^0-9.]/g, '')) : text.trim();
    if (['prix_achat', 'prix_vente', 'stock'].includes(champ) && isNaN(val)) return sendMessage(chatId, `⚠️ Valeur invalide.`);
    p[champ] = val;
    await envoyerVersSheets("modifier_produit", { id: p.id, nom: p.nom, variante: p.variante || "", champ, valeur: val });
    session.etape = null; session.data = {};
    return sendMessage(chatId, `✅ *${p.nom}${p.variante ? ' — '+p.variante : ''}* mis à jour !`, { reply_markup: menuProduits() });
  }

  // ══ CLIENTS ═══════════════════════════════════════════════════════════════

  if (text === "👥 Clients") return sendMessage(chatId, `👥 *CLIENTS*`, { reply_markup: menuClients() });

  if (text === "📋 Voir clients") {
    await chargerDepuisSheets();
    if (db.clients.length === 0) return sendMessage(chatId, `👥 Aucun client.`, { reply_markup: menuClients() });
    let m = `👥 *CLIENTS (${db.clients.length})*\n\n`;
    db.clients.forEach(c => {
      m += `👤 *${c.nom}*${c.telephone ? ` | 📱 ${c.telephone}` : ""}\n`;
      m += `   🛒 ${c.nb_achats} achat(s) — ${c.ca_total} FCFA\n\n`;
    });
    return sendMessage(chatId, m, { reply_markup: menuClients() });
  }

  if (text === "➕ Ajouter client") {
    session.etape = "client_nom"; session.data = {};
    return sendMessage(chatId, `👥 *Nouveau client*\n\nNom complet :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "client_nom") {
    session.data.nom = text;
    session.etape    = "client_tel";
    return sendMessage(chatId, `📱 Téléphone (ou "skip") :`);
  }

  if (session.etape === "client_tel") {
    const telSaisi = text === "skip" ? "" : text.trim().replace(/\s/g, "");
    if (telSaisi && telSaisi.length >= 8) {
      const existeT = db.clients.find(c => c.telephone && String(c.telephone).replace(/\s/g, "") === telSaisi);
      if (existeT) {
        session.etape = null; session.data = {};
        return sendMessage(chatId, `⚠️ *Numéro déjà enregistré !*\n👤 *${existeT.nom}* utilise déjà ce numéro.`, { reply_markup: menuClients() });
      }
    }
    session.data.telephone = telSaisi;
    session.etape          = "client_note";
    return sendMessage(chatId, `📝 Note (ou "skip") :`);
  }

  if (session.etape === "client_note") {
    const client = {
      id: genId(), nom: session.data.nom, telephone: session.data.telephone,
      note: text === "skip" ? "" : text,
      nb_achats: 0, ca_total: 0,
      derniere_visite: new Date().toISOString(), cree_le: new Date().toISOString(),
    };
    db.clients.push(client);
    await envoyerVersSheets("nouveau_client", {
      nom: client.nom, telephone: client.telephone, note: client.note,
      date: new Date().toLocaleString("fr-FR")
    });
    session.etape = null; session.data = {};
    return sendMessage(chatId,
      `✅ *Client ajouté !*\n👤 ${client.nom}\n📱 ${client.telephone || "—"}\n📝 ${client.note || "—"}`,
      { reply_markup: menuClients() }
    );
  }

  if (text === "🔍 Rechercher client") {
    await chargerDepuisSheets();
    session.etape = "recherche_client";
    return sendMessage(chatId, `🔍 Nom ou téléphone :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "recherche_client") {
    session.etape = null;
    const q = text.trim().toLowerCase();
    const res = db.clients.filter(c =>
      c.nom.toLowerCase().includes(q) ||
      (c.telephone && c.telephone.replace(/\s/g, "").includes(q))
    );
    if (res.length === 0) return sendMessage(chatId, `🔍 Aucun résultat pour "${text}"`, { reply_markup: menuClients() });
    let m = `🔍 *RÉSULTATS (${res.length})*\n\n`;
    res.forEach(c => {
      m += `👤 *${c.nom}*${c.telephone ? ` | 📱 ${c.telephone}` : ""}\n`;
      m += `   🛒 ${c.nb_achats} achat(s) | 💰 ${c.ca_total} FCFA\n`;
      if (c.note) m += `   📝 ${c.note}\n`;
      m += "\n";
    });
    return sendMessage(chatId, m, { reply_markup: menuClients() });
  }

  // ── MODIFIER CLIENT ──────────────────────────────────────────────────────

  if (text === "✏️ Modifier client") {
    await chargerDepuisSheets();
    if (db.clients.length === 0) return sendMessage(chatId, `👥 Aucun client.`, { reply_markup: menuClients() });
    const b = db.clients.map(c => [`✏️ ${c.nom}`]); b.push(["❌ Annuler"]);
    session.etape = "modifier_client_choix"; session.data = {};
    return sendMessage(chatId, `✏️ *Modifier quel client ?*`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "modifier_client_choix") {
    const nom   = text.replace("✏️ ", "").trim();
    const client = db.clients.find(c => c.nom === nom);
    if (!client) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuClients() });
    session.data.client = client; session.etape = "modifier_client_champ";
    return sendMessage(chatId, `✏️ *${client.nom}*\n📱 ${client.telephone || "—"}\n📝 ${client.note || "—"}\n\nQue modifier ?`,
      { reply_markup: { keyboard: [["📛 Nom", "📱 Téléphone"], ["📝 Note"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "modifier_client_champ") {
    const cm = { "📛 Nom": "nom", "📱 Téléphone": "telephone", "📝 Note": "note" };
    if (!cm[text]) { session.etape = null; session.data = {}; return sendMessage(chatId, `❌ Annulé.`); }
    session.data.champ = cm[text]; session.etape = "modifier_client_valeur";
    return sendMessage(chatId, `✏️ Nouvelle valeur :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "modifier_client_valeur") {
    const client = session.data.client;
    client[session.data.champ] = text.trim();
    session.etape = null; session.data = {};
    return sendMessage(chatId, `✅ Client *${client.nom}* mis à jour !`, { reply_markup: menuClients() });
  }

  // ── SUPPRIMER CLIENT ─────────────────────────────────────────────────────

  if (text === "🗑️ Supprimer client") {
    await chargerDepuisSheets();
    if (db.clients.length === 0) return sendMessage(chatId, `👥 Aucun client.`, { reply_markup: menuClients() });
    const b = db.clients.map(c => [`🗑️ ${c.nom}`]); b.push(["❌ Annuler"]);
    session.etape = "supprimer_client_choix"; session.data = {};
    return sendMessage(chatId, `🗑️ *Supprimer quel client ?*`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "supprimer_client_choix") {
    const nom    = text.replace("🗑️ ", "").trim();
    const client  = db.clients.find(c => c.nom === nom);
    if (!client) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuClients() });
    session.data.client = client; session.etape = "supprimer_client_confirm";
    return sendMessage(chatId, `⚠️ Supprimer *${client.nom}* ?`, { reply_markup: { keyboard: [["✅ Confirmer suppression"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "supprimer_client_confirm") {
    if (text !== "✅ Confirmer suppression") {
      session.etape = null; session.data = {};
      return sendMessage(chatId, `❌ Annulé.`, { reply_markup: menuClients() });
    }
    const client = session.data.client;
    db.clients   = db.clients.filter(c => c.id !== client.id);
    await envoyerVersSheets("supprimer_client", { id: client.id, nom: client.nom });
    session.etape = null; session.data = {};
    return sendMessage(chatId, `✅ *${client.nom}* supprimé.`, { reply_markup: menuClients() });
  }

  // ── RELANCES ─────────────────────────────────────────────────────────────

  if (text === "📞 Clients à relancer") {
    if (db.relances.length === 0) {
      session.etape = "relance_client_nom"; session.data = {};
      return sendMessage(chatId, `📞 *Aucune relance*\n\nAjouter un client à relancer ?\nNom du client :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
    }
    const futures = db.relances.filter(r => r.statut !== "✅ Fait").sort((a, b) => new Date(a.date) - new Date(b.date));
    let m = `📞 *RELANCES (${futures.length})*\n\n`;
    futures.forEach((r, i) => {
      m += `${i+1}. 👤 *${r.client_nom}*\n`;
      if (r.client_tel) m += `   📱 ${r.client_tel}\n`;
      m += `   📅 ${formatDateFR(r.date)}\n`;
      if (r.note) m += `   📝 ${r.note}\n`;
      m += "\n";
    });
    return sendMessage(chatId, m, { reply_markup: { keyboard: [["➕ Ajouter relance"], ["🗑️ Marquer fait (relance)"], ["🏠 Menu"]], resize_keyboard: true } });
  }

  if (text === "➕ Ajouter relance") {
    session.etape = "relance_client_nom"; session.data = {};
    return sendMessage(chatId, `📞 *Nouvelle relance*\n\nNom du client :`, { reply_markup: { keyboard: db.clients.map(c => [c.nom]).concat([["❌ Annuler"]]), resize_keyboard: true } });
  }

  if (text === "🗑️ Marquer fait (relance)") {
    const futures = db.relances.filter(r => r.statut !== "✅ Fait");
    if (futures.length === 0) return sendMessage(chatId, `📞 Aucune relance en attente.`, { reply_markup: menuClients() });
    session.etape = "relance_marquer_fait";
    const b = futures.map((r, i) => [`${i+1}. ${r.client_nom} — ${formatDateFR(r.date)}`]); b.push(["❌ Annuler"]);
    return sendMessage(chatId, `✅ Quelle relance marquer comme faite ?`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "relance_marquer_fait") {
    session.etape = null;
    const idx = parseInt(text.split(".")[0]) - 1;
    const futures = db.relances.filter(r => r.statut !== "✅ Fait");
    if (isNaN(idx) || idx < 0 || idx >= futures.length) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuClients() });
    futures[idx].statut = "✅ Fait";
    return sendMessage(chatId, `✅ Relance *${futures[idx].client_nom}* marquée faite.`, { reply_markup: menuClients() });
  }

  if (session.etape === "relance_client_nom") {
    session.data.client_nom = text; session.etape = "relance_client_tel";
    return sendMessage(chatId, `📱 Téléphone (ou "skip") :`, { reply_markup: { keyboard: [["skip"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "relance_client_tel") {
    session.data.client_tel = text === "skip" ? "" : text; session.etape = "relance_note";
    return sendMessage(chatId, `📝 Note (ou "skip") :`, { reply_markup: { keyboard: [["skip"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "relance_note") {
    session.data.note = text === "skip" ? "" : text; session.etape = "relance_date";
    return sendMessage(chatId, `📅 Date de relance (ex: 20/06/2026 10:00) :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "relance_date") {
    try {
      const parts = text.trim().split(' ');
      const [j, m, a] = parts[0].split('/');
      const t = parts[1] || "09:00";
      const dateISO = new Date(`${a}-${m}-${j}T${t}:00+01:00`).toISOString();
      const relance = {
        id: genId(), client_nom: session.data.client_nom, client_tel: session.data.client_tel,
        note: session.data.note, date: dateISO,
        chatId: chatId, rappels_envoyes: [],
      };
      db.relances.push(relance);
      await envoyerVersSheets("nouvelle_relance", {
        client_nom: relance.client_nom, client_tel: relance.client_tel,
        note: relance.note, date: relance.date, date_creation: new Date().toLocaleString("fr-FR")
      });
      session.etape = null; session.data = {};
      return sendMessage(chatId, `✅ Relance ajoutée !\n👤 ${relance.client_nom}\n📅 ${formatDateFR(dateISO)}`, { reply_markup: menuClients() });
    } catch (err) {
      return sendMessage(chatId, `⚠️ Date invalide. Format: jj/mm/aaaa hh:mm`);
    }
  }

  // ── LIVRAISONS ────────────────────────────────────────────────────────────

  if (text === "🚚 Commandes à livrer") {
    if (db.livraisons.length === 0) {
      session.etape = "livraison_client_nom"; session.data = {};
      return sendMessage(chatId, `🚚 *Aucune livraison*\n\nNom du client :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
    }
    const futures = db.livraisons.filter(l => l.statut !== "✅ Livré").sort((a, b) => new Date(a.date) - new Date(b.date));
    let m = `🚚 *LIVRAISONS (${futures.length})*\n\n`;
    futures.forEach((l, i) => {
      m += `${i+1}. 👤 *${l.client_nom}*\n`;
      if (l.client_tel) m += `   📱 ${l.client_tel}\n`;
      if (l.produit)    m += `   🛒 ${l.produit}\n`;
      m += `   📅 ${formatDateFR(l.date)}\n`;
      if (l.note)       m += `   📝 ${l.note}\n`;
      m += "\n";
    });
    return sendMessage(chatId, m, { reply_markup: { keyboard: [["➕ Ajouter livraison"], ["🗑️ Marquer livré"], ["🏠 Menu"]], resize_keyboard: true } });
  }

  if (text === "➕ Ajouter livraison") {
    session.etape = "livraison_client_nom"; session.data = {};
    return sendMessage(chatId, `🚚 *Nouvelle livraison*\n\nNom du client :`, { reply_markup: { keyboard: db.clients.map(c => [c.nom]).concat([["❌ Annuler"]]), resize_keyboard: true } });
  }

  if (text === "🗑️ Marquer livré") {
    const futures = db.livraisons.filter(l => l.statut !== "✅ Livré");
    if (futures.length === 0) return sendMessage(chatId, `🚚 Aucune livraison en attente.`, { reply_markup: menuClients() });
    session.etape = "livraison_marquer_fait";
    const b = futures.map((l, i) => [`${i+1}. ${l.client_nom} — ${formatDateFR(l.date)}`]); b.push(["❌ Annuler"]);
    return sendMessage(chatId, `✅ Quelle livraison marquer comme livrée ?`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "livraison_marquer_fait") {
    session.etape = null;
    const idx     = parseInt(text.split(".")[0]) - 1;
    const futures = db.livraisons.filter(l => l.statut !== "✅ Livré");
    if (isNaN(idx) || idx < 0 || idx >= futures.length) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuClients() });
    futures[idx].statut = "✅ Livré";
    return sendMessage(chatId, `✅ Livraison *${futures[idx].client_nom}* marquée livrée.`, { reply_markup: menuClients() });
  }

  if (session.etape === "livraison_client_nom") {
    session.data.client_nom = text; session.etape = "livraison_client_tel";
    return sendMessage(chatId, `📱 Téléphone (ou "skip") :`, { reply_markup: { keyboard: [["skip"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "livraison_client_tel") {
    session.data.client_tel = text === "skip" ? "" : text; session.etape = "livraison_produit";
    return sendMessage(chatId, `🛒 Produit (ou "skip") :`, { reply_markup: { keyboard: db.produits.map(p => [p.nom + (p.variante ? ' — '+p.variante : '')]).concat([["skip"], ["❌ Annuler"]]), resize_keyboard: true } });
  }

  if (session.etape === "livraison_produit") {
    session.data.produit = text === "skip" ? "" : text; session.etape = "livraison_note";
    return sendMessage(chatId, `📝 Note (ou "skip") :`, { reply_markup: { keyboard: [["skip"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "livraison_note") {
    session.data.note = text === "skip" ? "" : text; session.etape = "livraison_date";
    return sendMessage(chatId, `📅 Date de livraison (ex: 25/06/2026 14:00) :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "livraison_date") {
    try {
      const parts = text.trim().split(' ');
      const [j, m, a] = parts[0].split('/');
      const t = parts[1] || "09:00";
      const dateISO = new Date(`${a}-${m}-${j}T${t}:00+01:00`).toISOString();
      const livraison = {
        id: genId(), client_nom: session.data.client_nom, client_tel: session.data.client_tel,
        produit: session.data.produit, note: session.data.note, date: dateISO,
        chatId: chatId, rappels_envoyes: [],
      };
      db.livraisons.push(livraison);
      await envoyerVersSheets("nouvelle_livraison", {
        client_nom: livraison.client_nom, client_tel: livraison.client_tel,
        produit: livraison.produit, note: livraison.note, date: livraison.date,
        date_creation: new Date().toLocaleString("fr-FR")
      });
      session.etape = null; session.data = {};
      return sendMessage(chatId, `✅ Livraison ajoutée !\n👤 ${livraison.client_nom}\n📅 ${formatDateFR(dateISO)}`, { reply_markup: menuClients() });
    } catch (err) {
      return sendMessage(chatId, `⚠️ Date invalide. Format: jj/mm/aaaa hh:mm`);
    }
  }

  // ══ VENTES ════════════════════════════════════════════════════════════════

  if (text === "💰 Ventes") return sendMessage(chatId, `💰 *VENTES*`, { reply_markup: menuVentes() });

  if (text === "📋 Voir ventes") {
    await chargerDepuisSheets();
    if (db.ventes.length === 0) return sendMessage(chatId, `💰 Aucune vente.`, { reply_markup: menuVentes() });
    session.etape = "voir_ventes_periode";
    return sendMessage(chatId, `📋 *Voir les ventes*\n\nChoisissez la période :`, { reply_markup: { keyboard: [["📅 Aujourd'hui", "📅 Cette semaine"], ["📅 Ce mois", "📅 Ce trimestre"], ["📅 Cette année", "📅 Tout voir"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "voir_ventes_periode") {
    await chargerDepuisSheets();
    session.etape = null;
    const now = new Date();
    let debut = null, labelPeriode = "";
    if (text === "📅 Aujourd'hui") {
      debut = new Date(now.toLocaleDateString('fr-FR', {timeZone:'Africa/Porto-Novo'}).split('/').reverse().join('-') + 'T00:00:00+01:00');
      labelPeriode = "Aujourd'hui";
    } else if (text === "📅 Cette semaine") {
      debut = new Date(now); const j = debut.getDay() || 7; debut.setDate(debut.getDate() - (j-1)); debut.setHours(0,0,0,0);
      labelPeriode = "Cette semaine";
    } else if (text === "📅 Ce mois") {
      debut = new Date(now.getFullYear(), now.getMonth(), 1); labelPeriode = "Ce mois";
    } else if (text === "📅 Ce trimestre") {
      debut = new Date(now.getFullYear(), Math.floor(now.getMonth()/3)*3, 1); labelPeriode = "Ce trimestre";
    } else if (text === "📅 Cette année") {
      debut = new Date(now.getFullYear(), 0, 1); labelPeriode = "Cette année";
    } else if (text === "📅 Tout voir") {
      debut = null; labelPeriode = "Toutes les ventes";
    } else {
      return sendMessage(chatId, `❌ Annulé.`, { reply_markup: menuVentes() });
    }
    const ventesFiltrees = debut ? db.ventes.filter(v => new Date(v.date) >= debut) : db.ventes;
    if (ventesFiltrees.length === 0) return sendMessage(chatId, `💰 Aucune vente pour *${labelPeriode}*.`, { reply_markup: menuVentes() });
    const ca    = ventesFiltrees.reduce((s, v) => s + (v.montant_total||0), 0);
    const marge = ventesFiltrees.reduce((s, v) => s + (v.marge_totale||0), 0);
    let m = `💰 *VENTES — ${labelPeriode}*\n📊 CA: *${ca} FCFA* | Marge: *${marge} FCFA* | ${ventesFiltrees.length} vente(s)\n\n`;
    const parJour = {};
    ventesFiltrees.forEach(v => {
      try {
        const d = new Date(v.date);
        const jourKey = d.toLocaleDateString('fr-FR', {timeZone:'Africa/Porto-Novo', day:'2-digit', month:'2-digit', year:'2-digit'});
        if (!parJour[jourKey]) parJour[jourKey] = [];
        parJour[jourKey].push(v);
      } catch(e) { if (!parJour['?']) parJour['?'] = []; parJour['?'].push(v); }
    });
    Object.keys(parJour).reverse().forEach(jour => {
      m += `📅 *${jour}*\n`;
      parJour[jour].forEach(v => {
        m += `🛒 *${v.produit_nom}${v.produit_variante ? ' — '+v.produit_variante : ''}* x${v.quantite} | 👤 ${v.client_nom} | 💰 ${v.montant_total} FCFA\n`;
      });
      m += `\n`;
    });
    return sendMessage(chatId, m, { reply_markup: menuVentes() });
  }

  // ── VENTE RAPIDE ─────────────────────────────────────────────────────────

  if (text === "➕ Vente rapide") {
    if (db.produits.length === 0) return sendMessage(chatId, `⚠️ Ajoutez d'abord un produit !`, { reply_markup: menuVentes() });
    session.etape = "vente_modele"; session.data = { panier: [] };
    const nomsUniques = [...new Set(db.produits.filter(p => p.stock > 0).map(p => p.nom))];
    const b = nomsUniques.map(nom => [`📦 ${nom}`]); b.push(["❌ Annuler"]);
    return sendMessage(chatId, `🛒 Choisissez le produit :`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "vente_modele") {
    const nomModele = text.replace("📦 ", "").trim();
    const variantes = db.produits.filter(p => p.nom === nomModele && p.stock > 0);
    if (variantes.length === 0) return sendMessage(chatId, `⚠️ Stock épuisé !`, { reply_markup: menuVentes() });
    if (variantes.length === 1 && !variantes[0].variante) {
      session.data.produit = variantes[0]; session.etape = "vente_quantite";
      return sendMessage(chatId, `📦 *${variantes[0].nom}*\n🗃️ Stock: ${variantes[0].stock}\n\n🔢 Quantité ?`, { reply_markup: { keyboard: [["1"], ["2"], ["3"], ["❌ Annuler"]], resize_keyboard: true } });
    }
    session.data.nomModele = nomModele; session.etape = "vente_produit";
    const b = variantes.map(p => [`🏷️ ${p.variante} (${p.stock} dispo)`]); b.push(["❌ Annuler"]);
    return sendMessage(chatId, `🏷️ Variante de *${nomModele}* :`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "vente_produit") {
    const varianteChoisie = text.replace("🏷️ ", "").replace(/ \(\d+ dispo\)$/, '').trim();
    const p = db.produits.find(p => p.nom === session.data.nomModele && p.variante === varianteChoisie && p.stock > 0);
    if (!p) return sendMessage(chatId, `⚠️ Non trouvé.`);
    session.data.produit = p; session.etape = "vente_quantite";
    return sendMessage(chatId, `🔢 Quantité ? (dispo: ${p.stock})`, { reply_markup: { keyboard: [["1"], ["2"], ["3"], ["5"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "vente_quantite") {
    const qte = parseInt(text);
    if (isNaN(qte) || qte < 1) return sendMessage(chatId, `⚠️ Invalide.`);
    if (qte > session.data.produit.stock) return sendMessage(chatId, `⚠️ Max: ${session.data.produit.stock}`);
    session.data.quantite = qte;
    const p = session.data.produit;
    // Prix revendeur disponible ?
    if (p.prix_revendeur && p.prix_revendeur > 0) {
      session.etape = "vente_type_client";
      return sendMessage(chatId, `📦 *${p.nom}${p.variante ? ' — '+p.variante : ''}* x${qte}\n\n👤 Type de vente :`,
        { reply_markup: { keyboard: [["🛒 Client normal", "🤝 Revendeur"], ["❌ Annuler"]], resize_keyboard: true } });
    }
    const prixTotal = p.prix_vente * qte;
    session.etape = "vente_reduction_manuelle";
    return sendMessage(chatId, `📦 *${p.nom}${p.variante ? ' — '+p.variante : ''}* x${qte}\n💰 Total : *${prixTotal} FCFA*\n\n🎁 Réduction ?`,
      { reply_markup: { keyboard: [["5%", "10%"], ["15%", "20%"], ["✏️ Montant exact"], ["❌ Pas de réduction"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "vente_type_client") {
    const p   = session.data.produit;
    const qte = session.data.quantite;
    if (text === "🤝 Revendeur") {
      if (!session.data.panier) session.data.panier = [];
      session.data.panier.push({ produit: p, quantite: qte, prix_unitaire: p.prix_revendeur, reduction: 0, total: p.prix_revendeur * qte, type: "revendeur" });
      session.data.produit = null; session.data.quantite = null;
      const panierTotal = session.data.panier.reduce((s, a) => s + a.total, 0);
      let recap = `🛒 *Panier (${session.data.panier.length} article(s))*\n`;
      session.data.panier.forEach((a, i) => { recap += `${i+1}. ${a.produit.nom}${a.produit.variante ? ' — '+a.produit.variante : ''} x${a.quantite} = ${a.total} FCFA${a.type==='revendeur' ? ' 🤝' : ''}\n`; });
      recap += `\n💰 *Total: ${panierTotal} FCFA*`;
      const bPanier = [];
      if (session.data.panier.length < 10) bPanier.push(["➕ Ajouter un article"]);
      bPanier.push(["✅ Finaliser la vente"], ["❌ Annuler"]);
      session.etape = "vente_panier";
      return sendMessage(chatId, recap, { reply_markup: { keyboard: bPanier, resize_keyboard: true } });
    }
    const prixTotal = p.prix_vente * qte;
    session.etape = "vente_reduction_manuelle";
    return sendMessage(chatId, `📦 *${p.nom}${p.variante ? ' — '+p.variante : ''}* x${qte}\n💰 Total : *${prixTotal} FCFA*\n\n🎁 Réduction ?`,
      { reply_markup: { keyboard: [["5%", "10%"], ["15%", "20%"], ["✏️ Montant exact"], ["❌ Pas de réduction"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "vente_reduction_manuelle") {
    let reductionManuelle = 0;
    if (text === "❌ Pas de réduction") {
      reductionManuelle = 0;
    } else if (text === "✏️ Montant exact") {
      session.etape = "vente_reduction_saisie";
      return sendMessage(chatId, `✏️ Montant à déduire (FCFA) :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
    } else {
      const pct = parseFloat(text.replace('%', ''));
      if (isNaN(pct) || pct < 0 || pct > 100) return sendMessage(chatId, `⚠️ Pourcentage invalide.`);
      reductionManuelle = pct;
    }
    const p    = session.data.produit;
    const qte  = session.data.quantite;
    const reduc = reductionManuelle || 0;
    const prixUnit = reduc > 0 ? Math.round(p.prix_vente * (1 - reduc/100)) : p.prix_vente;
    if (!session.data.panier) session.data.panier = [];
    session.data.panier.push({ produit: p, quantite: qte, prix_unitaire: prixUnit, reduction: reduc, total: prixUnit * qte });
    session.data.produit = null; session.data.quantite = null; session.data.reduction_manuelle = null;
    const panierTotal = session.data.panier.reduce((s, a) => s + a.total, 0);
    let recap = `🛒 *Panier (${session.data.panier.length} article(s))*\n`;
    session.data.panier.forEach((a, i) => { recap += `${i+1}. ${a.produit.nom}${a.produit.variante ? ' — '+a.produit.variante : ''} x${a.quantite} = ${a.total} FCFA${a.reduction ? ' 🎁-'+a.reduction+'%' : ''}\n`; });
    recap += `\n💰 *Total: ${panierTotal} FCFA*`;
    const bPanier = [];
    if (session.data.panier.length < 10 && db.produits.some(p => p.stock > 0)) bPanier.push(["➕ Ajouter un article"]);
    bPanier.push(["✅ Finaliser la vente"], ["❌ Annuler"]);
    session.etape = "vente_panier";
    return sendMessage(chatId, recap, { reply_markup: { keyboard: bPanier, resize_keyboard: true } });
  }

  if (session.etape === "vente_reduction_saisie") {
    const montantReduc = parseFloat(text.replace(/[^0-9.]/g, ''));
    const prixTotal    = session.data.produit.prix_vente * session.data.quantite;
    if (isNaN(montantReduc) || montantReduc < 0 || montantReduc >= prixTotal)
      return sendMessage(chatId, `⚠️ Montant invalide. Max: ${prixTotal - 1} FCFA`);
    const pct = (montantReduc / prixTotal) * 100;
    session.data.reduction_manuelle     = pct;
    session.data.reduction_montant_exact = montantReduc;
    session.etape = "vente_client";
    const prixBase   = session.data.produit.prix_vente * session.data.quantite;
    const prixReduit = Math.round(prixBase * (1 - pct/100));
    const vraisClients = db.clients.filter(c => !db.produits.some(p => p.nom.toLowerCase() === c.nom.toLowerCase()));
    return sendMessage(chatId, `✅ Réduction *${pct.toFixed(1)}%*\n💰 ${prixBase} → *${prixReduit} FCFA*\n\n👤 Client ?`,
      { reply_markup: { keyboard: [...vraisClients.map(c => [c.nom]), ["➕ Nouveau client"], ["Anonyme"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "vente_panier") {
    if (text === "➕ Ajouter un article") {
      const nomsUniques = [...new Set(db.produits.filter(p => p.stock > 0).map(p => p.nom))];
      session.etape = "vente_modele";
      const b = nomsUniques.map(nom => [`📦 ${nom}`]); b.push(["❌ Annuler"]);
      return sendMessage(chatId, `🛒 Ajouter un article :`, { reply_markup: { keyboard: b, resize_keyboard: true } });
    }
    if (text === "✅ Finaliser la vente") {
      session.etape = "vente_client";
      const vraisClients = db.clients.filter(c => !db.produits.some(p => p.nom.toLowerCase() === c.nom.toLowerCase()));
      const panierTotal  = session.data.panier.reduce((s, a) => s + a.total, 0);
      const b = vraisClients.map(c => [c.nom]);
      b.push(["➕ Nouveau client"], ["Anonyme"], ["❌ Annuler"]);
      return sendMessage(chatId, `💰 Total: *${panierTotal} FCFA*\n\n👤 Client ?`, { reply_markup: { keyboard: b, resize_keyboard: true } });
    }
    session.etape = null; session.data = {};
    return sendMessage(chatId, `❌ Vente annulée.`, { reply_markup: menuVentes() });
  }

  if (session.etape === "vente_client") {
    const clientNom = text.replace("⭐ ", "").trim();
    if (clientNom === "➕ Nouveau client") {
      session.etape = "vente_nouveau_client_nom";
      return sendMessage(chatId, `👤 *Nouveau client*\n\nNom complet :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
    }
    await finaliserVente(chatId, session, clientNom === "Anonyme" ? null : clientNom);
    return;
  }

  if (session.etape === "vente_nouveau_client_nom") {
    session.data.nouveau_client = { nom: text.trim() };
    session.etape = "vente_nouveau_client_tel";
    return sendMessage(chatId, `📱 Téléphone du client (ou "skip") :`, { reply_markup: { keyboard: [["skip"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "vente_nouveau_client_tel") {
    const telClean = text === "skip" ? "" : text.trim().replace(/\s/g, "");
    if (telClean.length >= 8) {
      const existeTel = db.clients.find(c => c.telephone && String(c.telephone).replace(/\s/g, "") === telClean);
      if (existeTel) {
        session.data.client_existant = existeTel;
        session.etape = "vente_client_doublon";
        return sendMessage(chatId, `⚠️ *Numéro déjà enregistré !*\n👤 *${existeTel.nom}*\n\nContinuer avec ce client ?`,
          { reply_markup: { keyboard: [["✅ Continuer avec ce client"], ["❌ Annuler"]], resize_keyboard: true } });
      }
    }
    session.data.nouveau_client.telephone = telClean;
    const nc = session.data.nouveau_client;
    const client = {
      id: genId(), nom: nc.nom, telephone: nc.telephone,
      note: "Créé via vente", nb_achats: 0, ca_total: 0,
      derniere_visite: new Date().toISOString(), cree_le: new Date().toISOString(),
    };
    db.clients.push(client);
    await envoyerVersSheets("nouveau_client", { nom: client.nom, telephone: client.telephone, note: client.note, date: new Date().toLocaleString("fr-FR") });
    await sendMessage(chatId, `✅ Client *${client.nom}* créé !`);
    await finaliserVente(chatId, session, client.nom);
    return;
  }

  if (session.etape === "vente_client_doublon") {
    if (text === "✅ Continuer avec ce client") {
      const client = session.data.client_existant;
      session.data.client_existant = null;
      await finaliserVente(chatId, session, client.nom);
      return;
    }
    session.etape = null; session.data = {};
    return sendMessage(chatId, `❌ Annulé.`, { reply_markup: menuVentes() });
  }

  // ── VENTE TEXTE ──────────────────────────────────────────────────────────

  if (text === "📝 Vente texte") {
    session.etape = "vente_texte";
    return sendMessage(chatId, `📝 *Vente texte*\n\nUne vente par ligne : 'produit quantité client'\n\nEx:\n\`\`\`\nT-shirt rouge 2 Karim\nSac 1 Sophie\n\`\`\``, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "vente_texte") {
    await sendMessage(chatId, `⏳ Analyse en cours...`);
    const produitsDispo = db.produits.map(p => p.nom + (p.variante ? ' '+p.variante : '')).join(", ");
    const clientsDispo  = db.clients.map(c => c.nom).join(", ");
    let ventesExtraites;
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: `Tu es un assistant commercial. Extrais toutes les ventes de ce texte.\nProduits disponibles : ${produitsDispo || "aucun"}\nClients connus : ${clientsDispo || "aucun"}\n\nTexte : "${text}"\n\nRéponds UNIQUEMENT en JSON :\n[{"produit":"nom exact","quantite":1,"client":"nom ou null","telephone":"numéro ou null"}]` }],
        max_tokens: 300, temperature: 0,
      });
      const raw = completion.choices[0].message.content.replace(/\`\`\`json|\`\`\`/g, "").trim();
      ventesExtraites = JSON.parse(raw);
    } catch (err) {
      session.etape = null; session.data = {};
      return sendMessage(chatId, `❌ Texte non compris. Ex: 'T-shirt rouge 2 Karim'`, { reply_markup: menuVentes() });
    }

    let resultMsg = "", totalCA = 0, nbOk = 0;
    for (const v of ventesExtraites) {
      if (!v.produit || !v.quantite) continue;
      if (v.client) {
        const existe = db.clients.find(c => c.nom.toLowerCase().includes(v.client.toLowerCase()));
        if (!existe) {
          const nc = { id: genId(), nom: v.client.trim(), telephone: v.telephone || "", note: "Créé via vente", nb_achats: 0, ca_total: 0, derniere_visite: new Date().toISOString(), cree_le: new Date().toISOString() };
          db.clients.push(nc);
          await envoyerVersSheets("nouveau_client", { nom: nc.nom, telephone: nc.telephone, note: nc.note, date: new Date().toLocaleString("fr-FR", { timeZone: "Africa/Porto-Novo" }) });
        }
      }
      const result = await enregistrerVenteComplete(v.produit, v.quantite, v.client || null);
      if (result.erreur) { resultMsg += `❌ ${result.erreur}\n`; }
      else {
        resultMsg += `✅ *${result.vente.produit_nom}* x${result.vente.quantite} — ${result.vente.montant_total} FCFA${result.alerte ? ' ⚠️' : ''}\n`;
        totalCA += result.vente.montant_total; nbOk++;
      }
    }
    session.etape = null; session.data = {};
    if (nbOk === 0) return sendMessage(chatId, `❌ Aucune vente reconnue.`, { reply_markup: menuVentes() });
    return sendMessage(chatId, resultMsg + `\n💰 *Total : ${totalCA} FCFA* (${nbOk} vente(s))`, { reply_markup: menuVentes() });
  }

  // ── MODIFIER VENTE ───────────────────────────────────────────────────────

  if (text === "✏️ Modifier vente") {
    await chargerDepuisSheets();
    if (db.ventes.length === 0) return sendMessage(chatId, `💰 Aucune vente.`, { reply_markup: menuVentes() });
    const dernV = db.ventes.slice(0, 10);
    const b = dernV.map(v => {
      let d = ""; try { d = new Date(v.date).toLocaleDateString('fr-FR', {timeZone:'Africa/Porto-Novo', day:'2-digit', month:'2-digit'}); } catch(e) {}
      return [`✏️ ${d} ${v.produit_nom} | ${v.client_nom} | ${v.montant_total} FCFA`];
    });
    b.push(["❌ Annuler"]);
    session.etape = "modifier_vente_choix"; session.data = {};
    return sendMessage(chatId, `✏️ *Modifier quelle vente ?*\n_(10 dernières)_`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "modifier_vente_choix") {
    const label = text.replace("✏️ ", "").trim();
    const vente = db.ventes.find(v => {
      let d = ""; try { d = new Date(v.date).toLocaleDateString('fr-FR', {timeZone:'Africa/Porto-Novo', day:'2-digit', month:'2-digit'}); } catch(e) {}
      return `${d} ${v.produit_nom} | ${v.client_nom} | ${v.montant_total} FCFA` === label;
    });
    if (!vente) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuVentes() });
    session.data.vente = vente; session.etape = "modifier_vente_champ";
    return sendMessage(chatId, `✏️ *${vente.produit_nom}* | ${vente.client_nom} | ${vente.montant_total} FCFA\nQue modifier ?`,
      { reply_markup: { keyboard: [["👤 Client", "💰 Prix"], ["📦 Quantité"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "modifier_vente_champ") {
    const cm = { "👤 Client": "client_nom", "💰 Prix": "montant_total", "📦 Quantité": "quantite" };
    if (!cm[text]) { session.etape = null; session.data = {}; return sendMessage(chatId, `❌ Annulé.`, { reply_markup: menuVentes() }); }
    session.data.champ = cm[text]; session.etape = "modifier_vente_valeur";
    return sendMessage(chatId, `✏️ Nouvelle valeur :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "modifier_vente_valeur") {
    const vente = session.data.vente; const champ = session.data.champ;
    const val   = ['montant_total', 'quantite'].includes(champ) ? parseFloat(text.replace(/[^0-9.]/g, '')) : text.trim();
    if (['montant_total', 'quantite'].includes(champ) && isNaN(val)) return sendMessage(chatId, `⚠️ Valeur invalide.`);
    vente[champ] = val;
    await envoyerVersSheets("modifier_vente", { id: vente.id, client: vente.client_nom, montant_total: vente.montant_total, quantite: vente.quantite });
    session.etape = null; session.data = {};
    return sendMessage(chatId, `✅ Vente mise à jour !`, { reply_markup: menuVentes() });
  }

  // ── SUPPRIMER VENTE ───────────────────────────────────────────────────────

  if (text === "🗑️ Supprimer vente") {
    await chargerDepuisSheets();
    if (db.ventes.length === 0) return sendMessage(chatId, `💰 Aucune vente.`, { reply_markup: menuVentes() });
    const dernV = db.ventes.slice(0, 10);
    const b = dernV.map(v => {
      let d = ""; try { d = new Date(v.date).toLocaleDateString('fr-FR', {timeZone:'Africa/Porto-Novo', day:'2-digit', month:'2-digit'}); } catch(e) {}
      return [`🗑️ ${d} ${v.produit_nom} | ${v.client_nom} | ${v.montant_total} FCFA`];
    });
    b.push(["❌ Annuler"]);
    session.etape = "supprimer_vente_choix"; session.data = {};
    return sendMessage(chatId, `🗑️ *Supprimer quelle vente ?*\n_(10 dernières)_`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "supprimer_vente_choix") {
    const label = text.replace("🗑️ ", "").trim();
    const vente = db.ventes.find(v => {
      let d = ""; try { d = new Date(v.date).toLocaleDateString('fr-FR', {timeZone:'Africa/Porto-Novo', day:'2-digit', month:'2-digit'}); } catch(e) {}
      return `${d} ${v.produit_nom} | ${v.client_nom} | ${v.montant_total} FCFA` === label;
    });
    if (!vente) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuVentes() });
    session.data.vente = vente; session.etape = "supprimer_vente_confirm";
    return sendMessage(chatId, `⚠️ Supprimer vente *${vente.produit_nom} — ${vente.client_nom} — ${vente.montant_total} FCFA* ?`, { reply_markup: { keyboard: [["✅ Confirmer suppression"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "supprimer_vente_confirm") {
    if (text !== "✅ Confirmer suppression") { session.etape = null; session.data = {}; return sendMessage(chatId, `❌ Annulé.`, { reply_markup: menuVentes() }); }
    const vente = session.data.vente;
    db.ventes    = db.ventes.filter(v => v.id !== vente.id);
    await envoyerVersSheets("supprimer_vente", { id: vente.id });
    session.etape = null; session.data = {};
    return sendMessage(chatId, `✅ Vente supprimée.`, { reply_markup: menuVentes() });
  }

  // ══ CHARGES ═══════════════════════════════════════════════════════════════

  await chargerDepuisSheets();
  if (text === "📊 Charges") {
    if (db.charges.length === 0) {
      session.etape = "charge_label"; session.data = {};
      return sendMessage(chatId, `📊 Aucune charge.\n\nLibellé :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
    }
    const total = db.charges.reduce((s, c) => s + c.montant, 0);
    let m = `📊 *CHARGES (${total} FCFA)*\n\n`;
    db.charges.forEach(c => m += `• *${c.label}* — ${c.montant} FCFA (${c.categorie})${c.produit_lie ? ` | 📦 ${c.produit_lie}` : ''}\n`);
    return sendMessage(chatId, m, { reply_markup: { keyboard: [["➕ Ajouter charge"], ["✏️ Modifier charge", "🗑️ Supprimer charge"], ["🏠 Menu"]], resize_keyboard: true } });
  }

  if (text === "➕ Ajouter charge") { session.etape = "charge_label"; session.data = {}; return sendMessage(chatId, `📊 *Nouvelle charge*\n\nLibellé :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } }); }

  if (session.etape === "charge_label") { session.data.label = text; session.etape = "charge_montant"; return sendMessage(chatId, `💵 Montant (FCFA) :`); }
  if (session.etape === "charge_montant") {
    const v = parseFloat(text.replace(/[^0-9.]/g, ""));
    if (isNaN(v)) return sendMessage(chatId, `⚠️ Montant invalide.`);
    session.data.montant = v; session.etape = "charge_categorie";
    return sendMessage(chatId, `🏷️ Catégorie :`, { reply_markup: { keyboard: [["Loyer"], ["Salaires"], ["Marketing"], ["Transport"], ["Autre"], ["❌ Annuler"]], resize_keyboard: true } });
  }
  if (session.etape === "charge_categorie") {
    session.data.categorie = text; session.etape = "charge_produit";
    const b = db.produits.map(p => [p.nom]); b.push(["Aucun (charge générale)"], ["❌ Annuler"]);
    return sendMessage(chatId, `📦 Associer à un produit ? (optionnel)`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }
  if (session.etape === "charge_produit") {
    const produit_lie = text === "Aucun (charge générale)" ? null : text;
    const c = { id: genId(), label: session.data.label, montant: session.data.montant, categorie: session.data.categorie, produit_lie, date: new Date().toISOString() };
    db.charges.push(c);
    await envoyerVersSheets("nouvelle_charge", { label: c.label, montant: c.montant, categorie: c.categorie, produit_lie: c.produit_lie || "", date: new Date().toLocaleString("fr-FR", { timeZone: "Africa/Porto-Novo" }) });
    session.etape = null; session.data = {};
    let msg = `✅ *Charge enregistrée !*\n📊 ${c.label} — ${c.montant} FCFA (${c.categorie})`;
    if (produit_lie) msg += `\n📦 Associée à : ${produit_lie}`;
    return sendMessage(chatId, msg, { reply_markup: menuPrincipal() });
  }

  if (text === "✏️ Modifier charge") {
    await chargerDepuisSheets();
    if (db.charges.length === 0) return sendMessage(chatId, `📊 Aucune charge.`);
    const b = db.charges.map(c => [`✏️ ${c.label} (${c.montant} FCFA)`]); b.push(["❌ Annuler"]);
    session.etape = "modifier_charge_choix"; session.data = {};
    return sendMessage(chatId, `✏️ *Modifier quelle charge ?*`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }
  if (session.etape === "modifier_charge_choix") {
    const charge = db.charges.find(c => text.includes(c.label));
    if (!charge) return sendMessage(chatId, `⚠️ Non trouvé.`);
    session.data.charge = charge; session.etape = "modifier_charge_champ";
    return sendMessage(chatId, `✏️ *${charge.label}* — ${charge.montant} FCFA\nQue modifier ?`,
      { reply_markup: { keyboard: [["📛 Libellé", "💰 Montant"], ["🏷️ Catégorie"], ["❌ Annuler"]], resize_keyboard: true } });
  }
  if (session.etape === "modifier_charge_champ") {
    const cm = { "📛 Libellé": "label", "💰 Montant": "montant", "🏷️ Catégorie": "categorie" };
    if (!cm[text]) { session.etape = null; session.data = {}; return sendMessage(chatId, `❌ Annulé.`); }
    session.data.champ = cm[text]; session.etape = "modifier_charge_valeur";
    return sendMessage(chatId, `✏️ Nouvelle valeur :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }
  if (session.etape === "modifier_charge_valeur") {
    const charge = session.data.charge; const champ = session.data.champ;
    const val    = champ === "montant" ? parseFloat(text.replace(/[^0-9.]/g, '')) : text.trim();
    if (champ === "montant" && isNaN(val)) return sendMessage(chatId, `⚠️ Montant invalide.`);
    charge[champ] = val;
    await envoyerVersSheets("modifier_charge", { id: charge.id, label: charge.label, montant: charge.montant, categorie: charge.categorie });
    session.etape = null; session.data = {};
    return sendMessage(chatId, `✅ Charge *${charge.label}* mise à jour !`);
  }

  if (text === "🗑️ Supprimer charge") {
    await chargerDepuisSheets();
    if (db.charges.length === 0) return sendMessage(chatId, `📊 Aucune charge.`);
    const b = db.charges.map(c => [`🗑️ ${c.label} (${c.montant} FCFA)`]); b.push(["❌ Annuler"]);
    session.etape = "supprimer_charge_choix"; session.data = {};
    return sendMessage(chatId, `🗑️ *Supprimer quelle charge ?*`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }
  if (session.etape === "supprimer_charge_choix") {
    const charge = db.charges.find(c => text.includes(c.label));
    if (!charge) return sendMessage(chatId, `⚠️ Non trouvé.`);
    db.charges = db.charges.filter(c => c.id !== charge.id);
    await envoyerVersSheets("supprimer_charge", { id: charge.id, label: charge.label });
    session.etape = null; session.data = {};
    return sendMessage(chatId, `✅ Charge *${charge.label}* supprimée.`);
  }

  // ══ STATS & ALERTES ═══════════════════════════════════════════════════════

  await chargerDepuisSheets();
  if (text === "📈 Stats") {
    session.etape = "stats_periode";
    return sendMessage(chatId, `📈 *Statistiques*\n\nChoisissez la période :`, {
      reply_markup: { keyboard: [["📅 Aujourd'hui", "📅 Cette semaine"], ["📅 Ce mois", "📅 Ce trimestre"], ["📅 Cette année", "📅 Tout voir"], ["🏠 Menu"]], resize_keyboard: true }
    });
  }

  if (session.etape === "stats_periode") {
    const now = new Date(); let debut = null, labelPeriode = "";
    if (text === "📅 Aujourd'hui") {
      debut = new Date(now.toLocaleDateString('fr-FR', {timeZone:'Africa/Porto-Novo'}).split('/').reverse().join('-') + 'T00:00:00+01:00'); labelPeriode = "Aujourd'hui";
    } else if (text === "📅 Cette semaine") {
      debut = new Date(now); const j = debut.getDay() || 7; debut.setDate(debut.getDate() - (j-1)); debut.setHours(0,0,0,0); labelPeriode = "Cette semaine";
    } else if (text === "📅 Ce mois") {
      debut = new Date(now.getFullYear(), now.getMonth(), 1); labelPeriode = "Ce mois";
    } else if (text === "📅 Ce trimestre") {
      debut = new Date(now.getFullYear(), Math.floor(now.getMonth()/3)*3, 1); labelPeriode = "Ce trimestre";
    } else if (text === "📅 Cette année") {
      debut = new Date(now.getFullYear(), 0, 1); labelPeriode = "Cette année";
    } else if (text === "📅 Tout voir") {
      debut = null; labelPeriode = "Depuis le début";
    } else {
      session.etape = null; return sendMessage(chatId, `⚠️ Période non reconnue.`, { reply_markup: menuPrincipal() });
    }
    const ventesFiltrees  = debut ? db.ventes.filter(v => new Date(v.date) >= debut) : db.ventes;
    const chargesFiltrees = debut ? db.charges.filter(c => new Date(c.date) >= debut) : db.charges;
    const ca           = ventesFiltrees.reduce((s, v) => s + (v.montant_total||0), 0);
    const marge_brute  = ventesFiltrees.reduce((s, v) => s + (v.marge_totale||0), 0);
    const total_charges = chargesFiltrees.reduce((s, c) => s + (c.montant||0), 0);
    const benefice_net  = marge_brute - total_charges;
    const topProduits = {};
    ventesFiltrees.forEach(v => {
      if (!topProduits[v.produit_nom]) topProduits[v.produit_nom] = { qte: 0, ca: 0 };
      topProduits[v.produit_nom].qte += v.quantite || 1;
      topProduits[v.produit_nom].ca  += v.montant_total || 0;
    });
    const top3 = Object.entries(topProduits).sort((a, b) => b[1].ca - a[1].ca).slice(0, 3);
    let msg = `📈 *STATS — ${labelPeriode}*\n\n`;
    msg += `💰 CA : *${ca.toFixed(0)} FCFA*\n`;
    msg += `✅ Marge brute : *${marge_brute.toFixed(0)} FCFA*\n`;
    msg += `📊 Charges : ${total_charges.toFixed(0)} FCFA\n`;
    msg += `🏆 Bénéfice net : *${benefice_net.toFixed(0)} FCFA*\n\n`;
    if (benefice_net > 0) {
      msg += `💡 *Répartition :*\n`;
      msg += `   💼 50% Réinvestissement : *${Math.round(benefice_net * 0.50)} FCFA*\n`;
      msg += `   🏦 30% Épargne : *${Math.round(benefice_net * 0.30)} FCFA*\n`;
      msg += `   🎯 20% Personnel : *${Math.round(benefice_net * 0.20)} FCFA*\n\n`;
    }
    msg += `🛒 Ventes : ${ventesFiltrees.length} | 👥 Clients : ${db.clients.length}\n`;
    if (top3.length > 0) {
      msg += `\n🏅 *Top produits :*\n`;
      top3.forEach(([nom, d], i) => { msg += `   ${i+1}. ${nom} — ${d.qte} vendu(s) — ${d.ca.toFixed(0)} FCFA\n`; });
    }
    session.etape = null;
    return sendMessage(chatId, msg, { reply_markup: menuPrincipal() });
  }

  if (text === "🚨 Alertes") {
    const alertes = getAlertes(); const ruptures = getRuptures();
    if (alertes.length === 0 && ruptures.length === 0) return sendMessage(chatId, `✅ Stock OK !`, { reply_markup: menuPrincipal() });
    let m = `🚨 *ALERTES STOCK*\n\n`;
    if (ruptures.length > 0) { m += `🔴 *Ruptures :*\n`; ruptures.forEach(p => m += `• ${p.nom}${p.variante ? ' — '+p.variante : ''}\n`); m += "\n"; }
    if (alertes.length > 0)  { m += `🟡 *Stock bas :*\n`;  alertes.forEach(p  => m += `• ${p.nom}${p.variante ? ' — '+p.variante : ''} — ${p.stock} unité(s)\n`); }
    return sendMessage(chatId, m, { reply_markup: menuPrincipal() });
  }

  // ══ AGENDA ════════════════════════════════════════════════════════════════

  if (text === "📅 Agenda") return sendMessage(chatId, `📅 *AGENDA*`, { reply_markup: menuAgenda() });

  if (text === "📋 Voir agenda") {
    await chargerDepuisSheets();
    const events = db.agenda.filter(e => new Date(e.date) > new Date()).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (events.length === 0) return sendMessage(chatId, `📅 Aucun événement.`, { reply_markup: menuAgenda() });
    let m = `📅 *AGENDA (${events.length} événement(s))*\n\n`;
    events.forEach((e, i) => {
      m += `${i+1}. *${e.titre}*\n   🕐 ${formatDateFR(e.date)}\n   🔔 ${e.rappels_envoyes.length}/5 rappels\n\n`;
    });
    return sendMessage(chatId, m, { reply_markup: menuAgenda() });
  }

  if (text === "🔍 Agenda du jour") {
    await chargerDepuisSheets();
    const auj = new Date(); auj.setHours(0,0,0,0);
    const demain = new Date(auj); demain.setDate(demain.getDate()+1);
    const events = db.agenda.filter(e => { const d = new Date(e.date); return d >= auj && d < demain; }).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (events.length === 0) return sendMessage(chatId, `📅 Aucun événement aujourd'hui.`, { reply_markup: menuAgenda() });
    let m = `📅 *AGENDA DU JOUR*\n\n`;
    events.forEach((e, i) => { m += `${i+1}. *${e.titre}*\n   🕐 ${formatDateFR(e.date)}\n\n`; });
    return sendMessage(chatId, m, { reply_markup: menuAgenda() });
  }

  if (text === "➕ Ajouter événement") {
    session.etape = "agenda_texte"; session.data = {};
    return sendMessage(chatId, `📅 *Nouvel événement*\n\nÉcrivez en langage naturel :\n• Réunion demain 10h\n• Livraison vendredi 14h\n• Appel lundi 9h30`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "agenda_texte") {
    await sendMessage(chatId, `⏳ Analyse en cours...`);
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: `Extrais le titre et la date de cet événement : "${text}"\nDate actuelle : ${new Date().toLocaleString('fr-FR', {timeZone:'Africa/Porto-Novo'})}\nRéponds UNIQUEMENT en JSON : {"titre":"titre","date_iso":"2024-01-01T10:00:00+01:00"}` }],
        max_tokens: 100, temperature: 0,
      });
      const raw   = completion.choices[0].message.content.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      const event  = {
        id: genId(), titre: parsed.titre, date: parsed.date_iso,
        chatId: chatId, rappels_envoyes: [], googleEventId: null,
      };
      db.agenda.push(event);
      const googleId = await creerEventGoogleCalendar(event.titre, event.date);
      if (googleId) event.googleEventId = googleId;
      await envoyerVersSheets("nouvel_evenement", {
        titre: event.titre, date: formatDateFR(event.date),
        date_iso: event.date, chat_id: chatId,
      });
      session.etape = null; session.data = {};
      return sendMessage(chatId, `✅ *Événement ajouté !*\n📅 *${event.titre}*\n🕐 ${formatDateFR(event.date)}${googleId ? "\n📆 Google Calendar ✅" : ""}`, { reply_markup: menuAgenda() });
    } catch (err) {
      session.etape = null; session.data = {};
      return sendMessage(chatId, `❌ Je n'ai pas compris la date. Réessayez.\nEx: "Réunion vendredi 10h"`, { reply_markup: menuAgenda() });
    }
  }

  if (text === "✏️ Modifier événement") {
    await chargerDepuisSheets();
    if (db.agenda.length === 0) return sendMessage(chatId, `📅 Aucun événement.`, { reply_markup: menuAgenda() });
    const b = db.agenda.map(e => [`✏️ ${e.titre} — ${formatDateFR(e.date)}`]); b.push(["❌ Annuler"]);
    session.etape = "modifier_event_choix"; session.data = {};
    return sendMessage(chatId, `✏️ *Modifier quel événement ?*`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "modifier_event_choix") {
    const label  = text.replace("✏️ ", "").trim();
    const event  = db.agenda.find(e => `${e.titre} — ${formatDateFR(e.date)}` === label);
    if (!event) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuAgenda() });
    session.data.event = event; session.etape = "modifier_event_champ";
    return sendMessage(chatId, `✏️ *${event.titre}* — ${formatDateFR(event.date)}\nQue modifier ?`,
      { reply_markup: { keyboard: [["📛 Titre", "📅 Date"], ["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "modifier_event_champ") {
    if (text !== "📛 Titre" && text !== "📅 Date") { session.etape = null; session.data = {}; return sendMessage(chatId, `❌ Annulé.`, { reply_markup: menuAgenda() }); }
    session.data.champ = text === "📛 Titre" ? "titre" : "date";
    session.etape = "modifier_event_valeur";
    return sendMessage(chatId, text === "📛 Titre" ? `✏️ Nouveau titre :` : `📅 Nouvelle date (ex: 15/06/2026 14:00) :`, { reply_markup: { keyboard: [["❌ Annuler"]], resize_keyboard: true } });
  }

  if (session.etape === "modifier_event_valeur") {
    const event = session.data.event;
    if (session.data.champ === "titre") { event.titre = text.trim(); }
    else {
      const parts = text.trim().split(' '); const [j, m, a] = parts[0].split('/'); const t = parts[1] || "00:00";
      event.date = new Date(`${a}-${m}-${j}T${t}:00+01:00`).toISOString(); event.rappels_envoyes = [];
    }
    await envoyerVersSheets("modifier_evenement", { id: event.id, titre: event.titre, date_iso: event.date });
    session.etape = null; session.data = {};
    return sendMessage(chatId, `✅ Événement *${event.titre}* mis à jour !`, { reply_markup: menuAgenda() });
  }

  if (text === "🗑️ Supprimer événement") {
    const events = db.agenda.filter(e => new Date(e.date) > new Date()).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (events.length === 0) return sendMessage(chatId, `📅 Aucun événement.`, { reply_markup: menuAgenda() });
    session.etape = "agenda_supprimer"; session.data.events = events;
    const b = events.map((e, i) => [`${i+1}. ${e.titre} — ${formatDateFR(e.date)}`]); b.push(["❌ Annuler"]);
    return sendMessage(chatId, `🗑️ Quel événement supprimer ?`, { reply_markup: { keyboard: b, resize_keyboard: true } });
  }

  if (session.etape === "agenda_supprimer") {
    session.etape = null;
    const idx = parseInt(text.split(".")[0]) - 1;
    const events = session.data.events;
    if (isNaN(idx) || idx < 0 || idx >= events.length) return sendMessage(chatId, `⚠️ Non trouvé.`, { reply_markup: menuAgenda() });
    const event = events[idx];
    if (event.googleEventId) await supprimerEventGoogleCalendar(event.googleEventId);
    db.agenda = db.agenda.filter(e => e.id !== event.id);
    return sendMessage(chatId, `✅ *${event.titre}* supprimé.`, { reply_markup: menuAgenda() });
  }

  // ══ IA ════════════════════════════════════════════════════════════════════

  if (text === "🤖 IA") return sendMessage(chatId, `🤖 *Assistant IA*`, { reply_markup: menuIA() });

  const questionsIA = {
    "📊 Analyse rentabilité": "Analyse ma rentabilité en 5 lignes max. Direct et chiffré.",
    "🚨 Produits à restock":  "Quels produits restock en urgence ? Liste uniquement ceux concernés.",
    "💡 Conseils CA":         "3 conseils concrets et chiffrés pour augmenter mon CA.",
  };

  if (text in questionsIA) {
    await sendMessage(chatId, `🤖 Analyse...`);
    return await repondreIA(chatId, questionsIA[text]);
  }

  if (text === "❓ Question libre") {
    session.etape = "ia_conversation";
    if (!session.data.ia_history) session.data.ia_history = [];
    return sendMessage(chatId, `🤖 *Mode conversation activé*\n\nPosez vos questions librement. Tapez "🏠 Menu" pour quitter.`, { reply_markup: { keyboard: [["🏠 Menu"]], resize_keyboard: true } });
  }

  if (session.etape === "ia_conversation") {
    if (!session.data.ia_history) session.data.ia_history = [];
    session.data.ia_history.push({ role: "user", content: text });
    if (session.data.ia_history.length > 20) session.data.ia_history = session.data.ia_history.slice(-20);
    await sendMessage(chatId, `🤖 _Réflexion..._`);
    return await repondreIAConversation(chatId, session);
  }

  // ══ PHOTOS ════════════════════════════════════════════════════════════════

  if (photo && session.etape !== 'produit_photo') {
    await sendMessage(chatId, `📸 Analyse en cours...`);
    try {
      const fileId   = photo[photo.length - 1].file_id;
      const fileRes  = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileRes.data.result.file_path;
      const imgRes   = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`, { responseType: "arraybuffer" });
      const base64   = Buffer.from(imgRes.data).toString("base64");
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: "text", text: `Produits en stock : ${db.produits.map(p => p.nom).join(", ")}. Identifie les produits visibles et propose des ventes. Réponds en français, concis.` }
        ]}],
        max_tokens: 300,
      });
      return sendMessage(chatId, `📸 *Analyse photo :*\n\n${completion.choices[0].message.content}`, { reply_markup: menuVentes() });
    } catch (err) {
      return sendMessage(chatId, `❌ Erreur analyse photo.`, { reply_markup: menuPrincipal() });
    }
  }

  return sendMessage(chatId, `❓ Utilisez le menu.`, { reply_markup: menuPrincipal() });
});

// ─────────────────────────────────────────
// IA — Fonctions
// ─────────────────────────────────────────
async function repondreIAConversation(chatId, session) {
  const contexte = {
    stats:     getStats(),
    produits:  db.produits.map(p => ({ nom: p.nom, variante: p.variante, achat: p.prix_achat, vente: p.prix_vente, stock: p.stock })),
    clients:   db.clients.map(c => ({ nom: c.nom, achats: c.nb_achats, ca: c.ca_total })),
    ventes:    db.ventes.slice(0, 10),
    charges:   db.charges,
    alertes:   getAlertes().map(p => p.nom),
    ruptures:  getRuptures().map(p => p.nom),
  };
  try {
    const messages = [
      { role: "system", content: `Tu es l'assistant commercial d'une boutique. Tu parles français, tu es chaleureux et professionnel. Données actuelles: ${JSON.stringify(contexte)}. Réponds de façon naturelle et concise.` },
      ...session.data.ia_history,
    ];
    const completion = await openai.chat.completions.create({ model: "gpt-4o", messages, max_tokens: 500, temperature: 0.7 });
    const reponse    = completion.choices[0].message.content;
    session.data.ia_history.push({ role: "assistant", content: reponse });
    return sendMessage(chatId, `🤖 ${reponse}`, { reply_markup: { keyboard: [["🏠 Menu"]], resize_keyboard: true } });
  } catch (err) {
    return sendMessage(chatId, `❌ Erreur IA : ${err.message}`, { reply_markup: menuPrincipal() });
  }
}

async function repondreIA(chatId, question) {
  const contexte = {
    stats:    getStats(),
    produits: db.produits.map(p => ({ nom: p.nom, achat: p.prix_achat, vente: p.prix_vente, stock: p.stock, marge: calculerMarge(p.prix_achat, p.prix_vente) })),
    clients:  db.clients.map(c => ({ nom: c.nom, achats: c.nb_achats, ca: c.ca_total })),
    ventes:   db.ventes.slice(0, 10),
    charges:  db.charges,
    alertes:  getAlertes().map(p => p.nom),
    ruptures: getRuptures().map(p => p.nom),
  };
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: `Assistant commercial. Français. MAX 8 lignes. Direct, chiffré, sans intro. Données : ${JSON.stringify(contexte)}` },
        { role: "user",   content: question },
      ],
      max_tokens: 300, temperature: 0.3,
    });
    return sendMessage(chatId, `🤖 ${completion.choices[0].message.content}`, { reply_markup: menuIA() });
  } catch (err) {
    return sendMessage(chatId, `❌ Erreur IA : ${err.message}`, { reply_markup: menuPrincipal() });
  }
}

// ─────────────────────────────────────────
// API REST
// ─────────────────────────────────────────
app.get("/ping",         (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
app.get("/api/stats",    (req, res) => res.json(getStats()));
app.get("/api/produits", (req, res) => res.json(db.produits));
app.get("/api/clients",  (req, res) => res.json(db.clients));
app.get("/api/ventes",   (req, res) => res.json(db.ventes));
app.get("/api/agenda",   (req, res) => res.json(db.agenda));
app.get("/api/alertes",  (req, res) => res.json({ alertes_bas: getAlertes(), ruptures: getRuptures() }));

// ─────────────────────────────────────────
// DÉMARRAGE
// ─────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 Serveur : http://localhost:${PORT}`);
  console.log(`🤖 OpenAI (GPT-4o) connecté`);
  console.log(`📊 Google Sheets : ${GAS_URL || "non configuré"}`);

  initGoogleCalendar();

  await chargerDepuisSheets();

  demarrerRappels();
  console.log(`📅 Rappels Telegram démarrés`);

  if (TELEGRAM_TOKEN) {
    try {
      await axios.post(`${TELEGRAM_API}/setWebhook`, { url: `${RENDER_URL}/webhook/${TELEGRAM_TOKEN}` });
      console.log(`✅ Webhook Telegram : ${RENDER_URL}/webhook/${TELEGRAM_TOKEN}`);
    } catch (err) { console.error(`❌ Webhook :`, err.message); }
  } else {
    console.log(`⚠️ TELEGRAM_BOT_TOKEN manquant`);
  }
});