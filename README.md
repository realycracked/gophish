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
| `public/vel-client.js` | Script injecté dans les pages proxifiées (réécriture des requêtes JS + barre de navigation). Servi tel quel, non bundlé. |
| `public/index.html`, `app.js` | Accueil (recherche YouTube + proxy). |
| `public/youtube.html`, `youtube.js` | Lecteur YouTube. |
| `public/style.css` | Thème sombre commun. |

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
