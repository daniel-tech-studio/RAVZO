# Intégrations externes — configuration

Toutes les valeurs secrètes vivent dans `backend/.env` (ignoré par git). Voir `backend/.env.example`.

## Cours BRVM — MansaAPI (offre gratuite)
- `MARKET_PROVIDER=mansa`, `MANSA_API_KEY`, `MANSA_DAILY_QUOTA=100`.
- 1 requête = 48 titres (`/markets/exchanges/IVORYCOAST/stocks`). Planifié 1×/h en séance (lun–ven 09–17 h UTC) ; bouton « Actualiser » ≤ 1/15 min ; réserve de 10 requêtes.
- Licence : mention « Data by MansaAPI » (lien) partout où les cours apparaissent ; conservation ≤ 24 h (purge horaire) ; pas de redistribution. Données agrégées, différées ≈ 30 min, non officielles.

## E-mail — SMTP
- `SMTP_HOST`, `SMTP_PORT=465` (SSL ; 587 injoignable depuis ici), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_NAME=RAVZO`, `SMTP_FROM_ADDRESS`.
- Destinataire : e-mail du propriétaire. Les adresses `.local/.test/.invalid/.example` ne reçoivent rien (statut `NOT_CONFIGURED`).
- Retries toutes les 5 min, `DEAD_LETTER` après 5 échecs. Message-ID dérivé de la clé de livraison.

## Push — Firebase Cloud Messaging (HTTP v1)
- Projet Firebase `ravzo-fbe55`. Serveur : `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_FILE=./secrets/firebase-service-account.json` (clé de compte de service, chmod 600, ignorée par git). Le serveur signe lui-même son jeton OAuth (JWT RS256) — aucun SDK Admin.
- App : `firebase_core` + `firebase_messaging`, config générée par `flutterfire configure --project=ravzo-fbe55` (`lib/firebase_options.dart`, `google-services.json`, `GoogleService-Info.plist`).
- Flux : appareil de confiance → `POST /api/v1/notifications/push-devices {token, platform}` (un jeton par appareil) ; déconnexion → `DELETE /notifications/push-devices/current` ; révocation d'appareil / récupération → jetons supprimés ; jeton `UNREGISTERED` → supprimé à l'envoi. Montants masqués dans le texte, lien profond dans `data.link`.
- **Android** : vérifié de bout en bout (émulateur Pixel 8 Pro, API 36) — réception app fermée, montant masqué, ouverture sur le bon écran.
- **iOS / macOS** : nécessitent une clé APNs (.p8, compte Apple Developer) à téléverser dans Firebase › Paramètres du projet › Cloud Messaging, plus la capacité « Push Notifications » dans Xcode. Sans elle, l'app affiche « En attente de la clé APNs ».

## Paiements — FeexPay (Mobile Money Bénin)
- `PSP_PROVIDER=feexpay`, `FEEXPAY_API_BASE` (prod `https://api-v2.feexpay.me`, sandbox `https://sandbox-api.feexpay.me`), `FEEXPAY_API_KEY` (`fp_…` = production, `test_key_…` = sandbox), `FEEXPAY_SHOP_ID`.
- **Frais** : FeexPay ne publie pas son barème Bénin. Renseigner les taux de VOTRE contrat : `FEEXPAY_PAYOUT_FEE_BP` (points de base, 100 = 1 %), `FEEXPAY_PAYOUT_FEE_MIN`, `FEEXPAY_PAYIN_FEE_BP`. Tant qu'ils sont vides : aucun paiement exécutable (`PSP_FEES_UNCONFIGURED`).
- **Argent réel** : avec une clé `fp_`, rien n'est exécuté tant que `PAYMENTS_LIVE_ENABLED=true` n'est pas posé explicitement. En sandbox (`test_key_`), exécution autorisée hors production.
- **Webhook** : tableau de bord FeexPay › Webhook › URL `https://<api>/api/v1/integrations/psp/webhooks/feexpay`, mode « Signature HMAC », secret `fxp_whsec_…` → `FEEXPAY_WEBHOOK_SECRET`. Sans secret, tout webhook est refusé (403). Vérification : HMAC-SHA256 de `timestamp.deliveryId.corps_brut`, fenêtre ±5 min, déduplication sur `x-feexpay-delivery-id`.
- **IP** : les payouts exigent l'IP du serveur dans la liste blanche FeexPay (onglet « IP List »), sinon `ERR_IP_NOT_AUTHORIZED`.
- **Solde par réseau** : un payout MTN débite le canal MTN de la boutique (montant + frais). Le canal doit être alimenté (payin) avant tout payout, sinon `400 Low Balance` → échec terminal, réservations libérées.
- Flux : app › Argent › Paiements › « Relier mon compte FeexPay » (solde d'ouverture = solde attesté FeexPay) ; payout → `PENDING` → webhook signé ou `/api/payouts/status/public/{ref}` → `SUCCESSFUL`/`FAILED`. Délai dépassé → `UNKNOWN`, jamais de renvoi ; la clé `Idempotency-Key` (= id du paiement) empêche tout doublon.
