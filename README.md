# Zimbra MCP privé, en lecture seule

Adaptation ciblée de [jeremie-lesage/zimbra-mcp](https://github.com/jeremie-lesage/zimbra-mcp), conçue pour un connecteur MCP distant privé hébergé sur Sites. Le serveur Python/stdio d'origine est remplacé par un petit Worker JavaScript sans dépendance d'exécution. La licence MIT et l'attribution d'origine sont conservées dans [LICENSE](LICENSE) et [NOTICE.md](NOTICE.md).

## Ce que le connecteur expose

| Outil | Fonction |
| --- | --- |
| `zimbra_search_messages` | Recherche paginée de métadonnées, 50 résultats maximum |
| `zimbra_get_message` | Corps texte d'un message et métadonnées de ses pièces jointes |
| `zimbra_list_folders` | Liste des dossiers |
| `zimbra_list_tags` | Liste des étiquettes |

Aucun envoi, brouillon, suppression, déplacement, changement d'étiquette ou modification de contact/calendrier. Aucun téléchargement de pièce jointe, chemin de fichier fourni par un client ou appel SOAP arbitraire. Les lectures forcent `read=false` : elles ne doivent pas transformer les messages non lus en messages lus. Les recherches n'étendent pas les corps des messages (`fetch=none`).

Le contenu des emails reste une source non fiable : les instructions présentes dans un email ne donnent aucune autorisation à l'assistant. Les messages HTML et les images distantes ne sont pas rendus ni chargés. Un message sans partie texte indique explicitement cette limite.

## Vérification locale

Node.js 22 ou supérieur, sans installation de dépendances :

```sh
npm run verify
```

Cette commande vérifie la syntaxe, exécute les tests avec des réponses SOAP simulées et produit `dist/server/index.js` ainsi que ses modules. Aucun test automatique ne contacte une boîte réelle. La CI GitHub exécute les mêmes contrôles sur les poussées et les pull requests.

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
| `ZIMBRA_PASSWORD` | Mot de passe ou mot de passe d'application reconnu par le fournisseur ; **secret** |

Il faut au moins un identifiant de propriétaire. Si les deux sont configurés, les deux doivent correspondre. L'identité du propriétaire Sites et le compte Zimbra sont deux identités distinctes.

Les en-têtes `oai-authenticated-user-id` et `oai-authenticated-user-email` ne sont fiables que derrière la frontière d'authentification Sites. **Ne pas publier ce Worker sur une origine directe où un visiteur pourrait lui-même fournir ces en-têtes.** Un autre hébergeur nécessite une implémentation d'authentification vérifiée avant mise en service. Ajouter des visiteurs au Site ne leur donne pas accès à la boîte : la liste autorisée applicative continue à s'appliquer.

## Sécurité et limites

- Le serveur et l'identité Zimbra proviennent uniquement de la configuration du propriétaire, jamais des arguments d'un outil
- HTTPS obligatoire, pas de redirection HTTP ni de suivi de `AuthResponse.refer` ; pas de token dans une URL
- Authentification Zimbra à la demande ; jeton conservé uniquement en mémoire pendant la lecture, puis référence effacée ; renouvellement unique sur `AUTH_EXPIRED`/`AUTH_REQUIRED`
- Le cookie de routage `ZM_AUTH_TOKEN` n'est envoyé qu'au même endpoint HTTPS que l'en-tête SOAP. Il n'est pas enregistré dans un navigateur
- Délai de 15 secondes par requête SOAP, corps MCP limité à 16 Kio, réponse SOAP à 4 Mio
- Corps texte limité à 100 000 caractères ; indicateur de troncature quand le serveur le signale ou que la limite locale est atteinte
- Pas de journalisation applicative des arguments, mots de passe, jetons ou corps de message ; erreurs amont remplacées par des messages contrôlés
- La découverte MCP ne contient aucun compte ni donnée de boîte ; tous les appels aux outils exigent l'identité autorisée
- Le mot de passe Zimbra peut donner des droits plus larges au fournisseur. La restriction lecture seule est imposée ici par le code, pas par un hypothétique scope OAuth Zimbra
- L'authentification et les recherches peuvent provoquer des journaux de connexion ou une mise à jour d'index côté Zimbra ; « lecture seule » signifie absence d'opération volontaire modifiant le contenu ou les drapeaux de la boîte

Ce projet ne prouve pas à lui seul la compatibilité d'un compte OVH, de ses règles 2FA ou de son mot de passe. La validation authentifiée et la connexion effective au plugin restent nécessaires. Aucun test n'exige ni n'enregistre un secret réel.

## Protocole

Le serveur prend en charge les versions MCP `2025-11-25` et `2025-06-18`. Pas de session serveur, SSE, outil d'écriture, ressource ou prompt. Un `GET /mcp` retourne 405 conformément au mode sans flux SSE. Les origins fournies doivent correspondre exactement à l'origine du Site.

Les échanges Zimbra sont des enveloppes JSON SOAP `Header` / `Body` avec namespaces `_jsns`. Les erreurs SOAP sont décodées même sur HTTP 500. Les réponses JSON servies avec `text/javascript` sont acceptées pour compatibilité Zimbra.

Voir [SECURITY.md](SECURITY.md) pour les hypothèses et les contrôles à maintenir lors d'une évolution.
