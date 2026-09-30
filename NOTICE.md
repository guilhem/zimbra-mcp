# Attribution et provenance

Les correspondances d'opérations SOAP et la conception initiale du connecteur proviennent de :

- Projet : https://github.com/jeremie-lesage/zimbra-mcp
- Auteur : Jérémie Lesage
- Licence : MIT, reproduite sans modification dans `LICENSE`
- Révision examinée : `2a0e2d2210fbc0f2e70780cedc9eba5294eea683` (branche `develop`)
- Fichiers de référence : `src/zimbra_mcp/client.py`, `server.py`, `tools/emails.py`, `tools/tags.py`

Cette adaptation est un port ciblé, pas une promesse de compatibilité avec tous les outils du projet d'origine. Elle garde la recherche, la lecture des messages, les dossiers et les étiquettes ; elle exclut explicitement les mutations et les téléchargements. Le transport stdio Python devient HTTP JSON sur un runtime Workers géré.

## Références primaires de vérification

- [Protocole SOAP Zimbra](https://github.com/Zimbra/zm-mailbox/blob/develop/store/docs/soap.txt)
- [AuthRequest](https://github.com/Zimbra/zm-mailbox/blob/develop/soap/src/java/com/zimbra/soap/account/message/AuthRequest.java)
- [GetMsg et conservation du drapeau UNREAD](https://github.com/Zimbra/zm-mailbox/blob/develop/store/src/java/com/zimbra/cs/service/mail/GetMsg.java)
- [Paramètres de recherche](https://github.com/Zimbra/zm-mailbox/blob/develop/soap/src/java/com/zimbra/soap/mail/type/MailSearchParams.java)
- [GetFolderRequest](https://github.com/Zimbra/zm-mailbox/blob/develop/soap/src/java/com/zimbra/soap/mail/message/GetFolderRequest.java)
- [Schéma du client JavaScript Zimbra](https://github.com/Zimbra/zm-api-js-client/blob/master/src/schema/schema.graphql)
- [Transport MCP HTTP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Une vérification publique sans compte, cookie ni mot de passe, effectuée le 30 septembre 2026 contre l'endpoint SOAP OVH, a reçu une erreur JSON Zimbra `service.AUTH_REQUIRED` (HTTP 500). Cela établit uniquement la disponibilité du protocole JSON SOAP, sans validation d'une boîte ou de ses données.
