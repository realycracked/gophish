# Vél·Tube

Passerelle web rapide, centrée sur YouTube, avec une interface sombre et lisible.
Cherche une vidéo (lecteur officiel, lecture directe depuis Google), ou ouvre
n'importe quel site via le proxy.

Tourne **100 % gratuit et 24 h/24** sur **Cloudflare Workers** (pas d'auto-hébergement,
pas de mise en veille).

## Fonctionnalités

- **Lecteur YouTube** (`/youtube`) : recherche (via Piped, avec repli direct sur
  YouTube) et lecture par le **lecteur officiel intégré** — la vidéo arrive direct
  de Google, sans passer par le proxy. File de lecture, précédent/suivant, lecture
  auto, mode cinéma, plein écran, **mode musique** (le lecteur se réduit en bas),
  **historique + reprise** là où on s'était arrêté (stocké sur l'appareil).
- **Proxy** : ouvre n'importe quel site. Réécriture des URLs en streaming, cache
  des ressources statiques au bord du réseau, et **barre de navigation** flottante
  injectée sur les pages ouvertes (retour / suivant / recharger / accueil / adresse
  / ouvrir l'original).

## Architecture

| Fichier | Rôle |
|---|---|
| `src/index.js` | Worker : routeur + moteur proxy (fetch, suppression des en-têtes bloquants, réécriture `HTMLRewriter`, cache, rattrapage des navigations). |
| `src/codec.js` | Encodage URL-safe réversible, partagé serveur/client. |
| `public/__vt/vel-client.js` | Script injecté dans les pages proxifiées (réécriture des requêtes JS + barre de navigation). Servi tel quel, non bundlé. |
| `public/__vt/index.html`, `app.js` | Accueil (recherche YouTube + proxy). |
| `public/__vt/youtube.html`, `youtube.js` | Lecteur YouTube. |
| `public/__vt/style.css` | Thème sombre commun. |

## Accueil

Écran façon téléphone : horloge, barre de recherche (YouTube ou Web), grille
d'« applis » avec les **vrais logos** des sites (récupérés par `/__vt/icon`, mis en
cache une semaine ; une lettre colorée s'il n'y en a pas), et un dock (Lecteur,
Favoris, Reprendre, Thème). « + » ajoute un site ; un appui long sur une icône
passe en mode édition pour en retirer.

## Échecs (`/__vt/chess`)

Sans proxy, tout passe par des *Durable Objects* Cloudflare (gratuits) :

- **Parties classées** : choix de la cadence (1, 3, 3|2, 5, 10, 15|10 min),
  **matchmaking** (adversaire de même cadence au plus proche en Elo), pendules
  (elles démarrent après le premier coup de chaque joueur), nulle proposée /
  acceptée, abandon, partie annulée si un joueur ne joue pas son premier coup
  en 45 s, défaite au temps.
- **Elo** : 1200 au départ, K = 40 pour les 30 premières parties puis 20 ;
  profil avec pseudo et bilan, **classement** des 20 meilleurs.
- **Entre amis** (non classé) : code de 5 caractères ou lien, avec ou sans pendule,
  revanche. Et **à deux sur cet écran**.
- Plateau façon chess.com : glisser-déposer, coups animés, sons.

`ChessLobby` (un seul objet) garde profils, file d'attente et classement ;
`ChessRoom` (un par partie) vérifie les coups avec chess.js et tient les pendules.

## Comment le proxy sert un site

- **Mode site** : le site ouvert est servi à la racine avec ses vrais chemins
  (`/play`, `/game/123`…), un cookie retient lequel. Les routes des web apps, les
  chemins relatifs et les modules JS fonctionnent comme sur le vrai site.
- **Autres domaines** (CDN, jeu dans une iframe…) : `/w/<origine encodée>/<vrai chemin>`.
- WebSockets relayés par le Worker ; `postMessage` entre la page et ses iframes
  corrigé ; cookies `__Host-` pris en charge ; service workers des sites bloqués.
- L'application elle-même vit sous `/__vt/` (`/` et `/youtube` y mènent).
- Recherche : page maison `/__vt/search` (résultats Bing en français analysés par
  le Worker, bande d'images, onglet Images, fiche Wikipédia). Google, DuckDuckGo,
  Brave, Startpage, Qwant et Yahoo bloquent les requêtes venant de Cloudflare, et
  la page Bing complète y arrive « dégradée » (ni images ni fiche).

Limites : un seul site en « mode site » à la fois (deux onglets sur deux sites
différents se gênent), et les captchas anti-robots (Cloudflare Turnstile…) ne
passent pas.

## Déploiement (une seule fois, ~5 min)

Compte **Cloudflare gratuit** (https://dash.cloudflare.com/sign-up) et **Node.js** requis.

```bash
npm install
npx wrangler login     # ouvre le navigateur
npm run deploy         # affiche ton URL : https://vel-proxy.<compte>.workers.dev
```

Pour mettre à jour : `git pull` puis `npm run deploy`. Le nom (et le début de l'URL)
se change dans `wrangler.toml` (`name`).

## Développement local

```bash
npm run dev     # http://127.0.0.1:8787
npm test        # tests unitaires (encodage + réécriture)
```

## Limites connues

- **YouTube** : la recherche dépend d'instances Piped (parfois instables) avec repli
  direct sur YouTube ; la lecture passe par le lecteur officiel (donc avec les pubs
  YouTube habituelles). Le **mode musique** garde le son tant que la page reste ouverte ;
  sur mobile, écran éteint, le navigateur peut mettre en pause (limite des lecteurs embarqués).
- **Proxy** : les sites très lourds ou en WebSocket peuvent être lents ou instables.
  Les WebSockets ne sont pas proxifiés.

## Sécurité

Le Worker refuse les adresses locales/internes (localhost, IP privées, métadonnées
cloud) pour éviter d'en faire un relais interne.
