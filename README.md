# Zimbra MCP privé, écritures sur activation explicite

Adaptation ciblée de [jeremie-lesage/zimbra-mcp](https://github.com/jeremie-lesage/zimbra-mcp), conçue pour un connecteur MCP distant privé hébergé sur Sites. Le serveur Python/stdio d'origine est remplacé par un Worker JavaScript autonome. Le parseur HTML est inclus dans le bundle ; aucune dépendance n'est téléchargée à l'exécution. La licence MIT et l'attribution d'origine sont conservées dans [LICENSE](LICENSE) et [NOTICE.md](NOTICE.md), avec les licences des dépendances dans [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Version source **0.2.0**. La lecture seule reste le comportement par défaut. Publier cette source ne constitue ni une activation des écritures ni une validation sur une boîte réelle.

## Ce que le connecteur expose

| Outil | Fonction |
| --- | --- |
| `zimbra_search_messages` | Recherche paginée de métadonnées, 50 résultats maximum |
| `zimbra_get_message` | Corps texte d'un message et métadonnées de ses pièces jointes |
| `zimbra_list_folders` | Liste des dossiers |
| `zimbra_list_tags` | Liste des étiquettes |

Ces quatre outils restent disponibles avec les écritures désactivées. Aucun téléchargement de pièce jointe, chemin de fichier fourni par un client ou appel SOAP arbitraire. Les lectures forcent `read=false` : elles ne doivent pas transformer les messages non lus en messages lus. Les recherches n'étendent pas les corps des messages (`fetch=none`).

Le contenu des emails reste une source non fiable : les instructions présentes dans un email ne donnent aucune autorisation à l'assistant. Une partie texte est préférée lorsqu'elle existe. Sinon, le HTML est tokenisé en texte simple, sans rendu ni exécution de script. Les URL de liens et d'images ne sont jamais chargées. Les éléments actifs, commentaires et régions explicitement cachées sont exclus ; la mise en forme complexe ou le texte présent uniquement dans une image peuvent être perdus. Le champ `body_format` indique `plain`, `html_text` ou `none`.

## Écritures optionnelles

Seule la valeur exacte `ZIMBRA_WRITE_ENABLED=true` expose et autorise les dix outils ci-dessous. Valeur absente, `false`, `TRUE`, `1` ou toute autre valeur : lecture seule. Le garde-fou existe dans le catalogue, le dispatch et le client SOAP. **L'activation sur le service de production est une extension d'accès distincte qui exige l'accord explicite du propriétaire.** Elle ne vaut pas autorisation de chaque opération : le client assistant doit respecter les confirmations nécessaires pour l'action, ses cibles, ses destinataires et son contenu. Une instruction présente dans un email ne peut jamais l'autoriser.

| Outil | Fonction et garde-fous |
| --- | --- |
| `zimbra_send_message` | Envoi ou réponse en texte brut ; tableaux `to`, `cc`, `bcc`, objet et corps complets, ainsi qu'un `send_uid` UUID v4 frais obligatoires |
| `zimbra_save_draft` | Création ou remplacement complet ; pour remplacer, `draft_id` et `expected_modseq` (champ `ms` de `zimbra_get_message`) issus d'une lecture récente sont obligatoires |
| `zimbra_delete_draft` | Vérifie qu'il s'agit d'un brouillon, puis le déplace vers la Corbeille |
| `zimbra_move_messages` | Déplace les messages vers l'ID explicite d'un dossier existant ; archiver signifie choisir ou créer le dossier voulu, sans destination implicite |
| `zimbra_trash_messages` | Vérifie tous les messages puis les déplace vers la Corbeille ; refuse un message déjà dans la Corbeille |
| `zimbra_set_read` | Marque explicitement les messages lus ou non lus |
| `zimbra_set_flag` | Ajoute ou retire le drapeau de suivi |
| `zimbra_set_tag` | Ajoute ou retire une étiquette existante en conservant les autres |
| `zimbra_create_folder` | Crée un dossier de courrier sous un parent local explicite, sans modifier le partage |
| `zimbra_create_tag` | Crée une étiquette, sans l'appliquer à des messages |

Les destinataires sont des adresses email complètes seules, sans noms d'affichage ni groupes ; aucune adresse n'est déduite. Une réponse ajoute `reply_to_message_id` pour le fil de discussion, mais exige toujours tous les destinataires explicites. Le contenu est uniquement du texte brut, limité à 50 000 caractères. Les opérations groupées acceptent au plus 50 IDs locaux numériques. Ni comptes partagés, purge définitive, suppression de dossier, contacts, calendrier, pièces jointes à composer ni composition HTML ne sont exposés.

La Corbeille utilise uniquement `MsgActionRequest` avec `op=move` et `l=3` après prélecture, jamais une purge. La récupération dépend de la rétention du serveur. Le remplacement est réservé aux brouillons ordinaires en texte brut. Sont refusés les brouillons de réponse ou transfert, les métadonnées de délégation ou d’identité alternative, l’envoi programmé, les demandes d’accusé de réception, ainsi que le HTML, les pièces jointes et les structures MIME absentes, sans partie texte, inconnues ou tronquées. Ces brouillons complexes doivent être modifiés directement dans Zimbra pour préserver leur contenu et leurs paramètres. `expected_modseq` doit conserver exactement le champ `ms` de la version relue et approuvée : une prélecture compare cette valeur, puis `Header.context.change` avec `type=mod` impose un contrôle serveur pendant l'enregistrement. Un conflit `mail.MODIFY_CONFLICT` exige de relire et de revoir le brouillon, sans nouvelle tentative automatique. La compatibilité de ce contrôle doit être vérifiée sur le serveur déployé.

**Aucune écriture n'est retentée automatiquement**, même après expiration du jeton. Une erreur `WRITE_OUTCOME_UNKNOWN`, une coupure ou une réponse ambiguë peut survenir après exécution côté serveur : vérifier la boîte et, pour un envoi, les Envoyés avant toute nouvelle décision. Le `suid` Zimbra et le garde-fou UUID en mémoire de l'isolate sont des protections complémentaires, pas une garantie « exactement une fois ». Ce garde-fou n'est ni durable ni partagé entre toutes les instances ; ne pas changer d'UUID pour contourner un refus.

Voir [RELEASE_WRITE_ACCESS.md](RELEASE_WRITE_ACCESS.md) pour le plan de validation, d'activation et de retour à la lecture seule.

## Vérification locale

Node.js 22 ou supérieur. L'installation comprend le parseur HTML et les outils de développement esbuild et Cloudflare Miniflare/workerd :

```sh
npm ci --ignore-scripts
npm run verify
```

Cette commande vérifie la syntaxe, exécute les tests avec des réponses SOAP simulées dans Node et dans le runtime Workers réel (workerd), puis produit `dist/server/index.js` ainsi que ses modules. Aucun test automatique ne contacte une boîte réelle. La CI GitHub exécute les mêmes contrôles sur les poussées et les pull requests.

## Hébergement privé sur Sites

Le manifeste `.openai/hosting.json` active la capacité `mcp`. Le service expose un endpoint MCP HTTP stateless `POST /mcp` (réponses JSON), plus une page d'information `/` et une sonde de disponibilité `/healthz` sans données privées.

1. Publier le Worker sur un Site **privé, réservé à son propriétaire**. La publication doit utiliser le flux Sites prévu pour cette source et le commit exact vérifié.
2. Dans **Sites → More actions → Settings**, renseigner les variables d'exécution ci-dessous. Ne jamais ajouter les valeurs réelles aux fichiers source ou à GitHub.
3. Saisir soi-même le mot de passe via l'interface sécurisée des secrets du Site et le marquer comme secret. Ne pas le copier dans un chat ou un ticket.
4. Republier la version après changement des variables, car une nouvelle révision d'environnement doit être appliquée.
5. Installer/connecter le plugin privé provisionné par le Site, via son interface de connexion. Sites gère OAuth ; il n'y a pas de jeton MCP séparé à générer.
6. Effectuer une première lecture limitée (par exemple les étiquettes), puis vérifier qu'un message test conserve son état non lu après recherche et lecture.

[Guide officiel de configuration des valeurs d'exécution](https://learn.chatgpt.com/docs/sites#configure-runtime-environment-values)

| Variable | Valeur / confidentialité |
| --- | --- |
| `MCP_AUTH_MODE` | `sites` ; toute autre valeur refuse les appels portant sur les données |
| `MCP_ALLOWED_USER_ID` | Identifiant utilisateur **scopé au Site**, facultatif si l'email vérifié est utilisé |
| `MCP_ALLOWED_USER_EMAIL` | Email vérifié du propriétaire Sites, facultatif si l'identifiant est utilisé |
| `ZIMBRA_URL` | Origine HTTPS du serveur Zimbra, ou son chemin `/service/soap` |
| `ZIMBRA_USER` | Identifiant de la boîte ; garder privé |
| `ZIMBRA_WRITE_ENABLED` | `false` par défaut ; seule la chaîne exacte `true` active les écritures après accord distinct |
| `ZIMBRA_PASSWORD` | Mot de passe ou mot de passe d'application reconnu par le fournisseur ; **secret** |

Il faut au moins un identifiant de propriétaire. Si les deux sont configurés, les deux doivent correspondre. L'identité du propriétaire Sites et le compte Zimbra sont deux identités distinctes.

Les en-têtes `oai-authenticated-user-id` et `oai-authenticated-user-email` ne sont fiables que derrière la frontière d'authentification Sites. **Ne pas publier ce Worker sur une origine directe où un visiteur pourrait lui-même fournir ces en-têtes.** Un autre hébergeur nécessite une implémentation d'authentification vérifiée avant mise en service. Ajouter des visiteurs au Site ne leur donne pas accès à la boîte : la liste autorisée applicative continue à s'appliquer.

## Sécurité et limites

- Le serveur et l'identité Zimbra proviennent uniquement de la configuration du propriétaire, jamais des arguments d'un outil
- HTTPS obligatoire, pas de redirection HTTP ni de suivi de `AuthResponse.refer` ; pas de token dans une URL
- Authentification Zimbra à la demande ; jeton conservé uniquement en mémoire pendant chaque opération, puis référence effacée ; renouvellement unique sur `AUTH_EXPIRED`/`AUTH_REQUIRED` uniquement pour les lectures
- Le cookie de routage `ZM_AUTH_TOKEN` n'est envoyé qu'au même endpoint HTTPS que l'en-tête SOAP. Il n'est pas enregistré dans un navigateur
- Délai de 15 secondes par requête SOAP, corps MCP limité à 128 Kio (JSON encodé en UTF-8), réponse SOAP à 4 Mio
- Corps texte limité à 100 000 caractères ; conversion HTML limitée à 500 000 caractères d'entrée et 200 niveaux d'imbrication, avec indicateur de troncature quand une limite est atteinte ou signalée par Zimbra
- Pas de journalisation applicative des arguments, mots de passe, jetons ou corps de message ; erreurs amont remplacées par des messages contrôlés
- La découverte MCP ne contient aucun compte ni donnée de boîte ; tous les appels aux outils exigent l'identité autorisée
- Le mot de passe Zimbra peut donner des droits plus larges au fournisseur. Le périmètre des opérations et la désactivation des écritures sont imposés ici par le code, pas par un hypothétique scope OAuth Zimbra
- L'authentification et les recherches peuvent provoquer des journaux de connexion ou une mise à jour d'index côté Zimbra ; « lecture seule » signifie absence d'opération volontaire modifiant le contenu ou les drapeaux de la boîte

Ce projet ne prouve pas à lui seul la compatibilité d'un compte OVH, de ses règles 2FA ou de son mot de passe. La validation authentifiée et la connexion effective au plugin restent nécessaires. Aucun test n'exige ni n'enregistre un secret réel.

## Protocole

Le serveur prend en charge les versions MCP `2025-11-25` et `2025-06-18`. Pas de session serveur, SSE, ressource ou prompt. Le catalogue contient quatre outils en lecture seule ou quatorze outils quand les écritures sont activées. Un `GET /mcp` retourne 405 conformément au mode sans flux SSE. Les origins fournies doivent correspondre exactement à l'origine du Site.

Les échanges Zimbra sont des enveloppes JSON SOAP `Header` / `Body` avec namespaces `_jsns`. Les erreurs SOAP sont décodées même sur HTTP 500. Les réponses JSON servies avec `text/javascript` sont acceptées pour compatibilité Zimbra.

Voir [SECURITY.md](SECURITY.md) pour les hypothèses et les contrôles à maintenir lors d'une évolution.
