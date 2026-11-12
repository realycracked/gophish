# Vél·Proxy

Passerelle web rapide avec une interface **Nébula** (sombre, néon). Colle une
adresse ou lance une recherche pour ouvrir n'importe quel site à travers le
proxy, avec un accès direct à YouTube et un catalogue de jeux.

Tourne **100 % gratuit et 24 h/24** sur **Cloudflare Workers** (pas d'auto-hébergement,
pas de serveur à garder allumé, pas de mise en veille).

## Comment ça marche

- **Interface statique** (`public/`) servie par le réseau edge de Cloudflare.
- **Worker** (`src/index.js`) : reçoit `/p/<code>`, va chercher la page cible,
  retire les en-têtes qui bloquent l'affichage (CSP, X-Frame-Options…), réécrit
  les URLs **en streaming** avec `HTMLRewriter` (très rapide) et renvoie le flux.
- **Client injecté** (`src/client.js`) : dans chaque page proxifiée, réécrit à la
  volée les requêtes créées par le JavaScript du site (`fetch`, `XHR`, nouveaux
  éléments, `window.open`) pour qu'elles repassent par le proxy.

## Déploiement (une seule fois, ~5 min)

Il te faut un compte **Cloudflare gratuit** (https://dash.cloudflare.com/sign-up)
et **Node.js** installé.

```bash
# 1. installer les dépendances
npm install

# 2. se connecter à Cloudflare (ouvre le navigateur)
npx wrangler login

# 3. déployer
npm run deploy
```

Wrangler affiche l'URL finale, du type `https://vel-proxy.<ton-compte>.workers.dev`.
C'est l'adresse de ton proxy. Pour mettre à jour, relance `npm run deploy`.

### Changer le nom

Le nom du Worker (et donc le début de l'URL) se change dans `wrangler.toml`,
champ `name`. Le nom affiché dans l'interface est dans `public/index.html`.

## Développement local

```bash
npm run dev     # serveur local sur http://127.0.0.1:8787
npm test        # tests unitaires (encodage + réécriture)
```

## Le catalogue de jeux

Modifie `public/games.json` (`name`, `cat`, `url`). Chaque jeu s'ouvre à travers
le proxy.

## Limites connues (honnêtes)

- **YouTube** : fonctionne pour la navigation et beaucoup de vidéos, mais Google
  bloque parfois les adresses IP de centres de données (« confirmez que vous
  n'êtes pas un robot ») et l'offre gratuite de Cloudflare limite le streaming
  vidéo très intensif. Correct, sans garantie de fiabilité dans le temps.
- **Jeux** : les titres simples (2048, Cookie Clicker, échecs…) marchent le mieux.
  Les jeux **WebGL** ou **multijoueur** (Krunker, Agar, Diep, Skribbl…) utilisent
  souvent des WebSockets non proxifiés en v1 et peuvent être instables.
- **Sites très « SPA »** (applications JavaScript lourdes) : la plupart des cas
  courants sont gérés, mais certains chemins dynamiques exotiques peuvent casser.
- Les requêtes **WebSocket** ne sont pas encore proxifiées (prévu pour une v2).

## Sécurité

Le Worker refuse les adresses locales/internes (localhost, IP privées, métadonnées
cloud) pour éviter d'en faire un relais vers des ressources internes.
