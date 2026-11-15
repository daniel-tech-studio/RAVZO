# RAVZO — État réel d'implémentation (14/11/2026, session 1 + vérification UI)

Le statut écrit ne prévaut jamais sur le code et les tests. Vérifications réellement exécutées : voir § Preuves.

## Synthèse
| Domaine | État |
|---|---|
| Backend NestJS (21 modules, 146 routes OpenAPI) | **Implémenté et testé** (37 tests d'intégration sur PostgreSQL réel, 3 exécutions consécutives vertes) |
| Registre double entrée + invariants SQL | **Vérifié** (trigger d'équilibre différé, append-only, recomptage des projections) |
| Client Flutter (5 espaces + sécurité, ops, notifications, recherche, sync, préférences) | **Implémenté**, compilé macOS, `flutter analyze` 0 erreur / 0 avertissement ; vérification visuelle partielle (voir § Visuel) |
| Paiements réels | **Adaptateur FeexPay implémenté, exécution désactivée** — payout MTN/Moov/Celtiis Bénin, payin, statut, solde par réseau, webhooks HMAC horodatés, Idempotency-Key ; 17 tests (unitaires + intégration contre un FeexPay simulé local). Vérifié en réel : clé de production acceptée, solde de la boutique lu (0 F sur chaque réseau). Bloqué volontairement : barème de frais du contrat non renseigné, secret de webhook absent, `PAYMENTS_LIVE_ENABLED=false`, API non exposée en HTTPS (webhook), IP du serveur à déclarer chez FeexPay. Aucun payout réel effectué. |
| Cotations BRVM | **Actif (MansaAPI, offre gratuite)** — 48 titres, différés ≈30 min, 1 requête par actualisation (≈9/jour planifiées en séance + manuelle ≤ 1/15 min, réserve de 10 sur 100), mention « Data by MansaAPI », purge > 24 h (licence). Vérifié en direct. Non officiel : pas de cotation BRVM de référence. |
| E-mail | **Implémenté** — SMTP authentifié (port 465 vérifié), expéditeur « RAVZO », retries + dead-letter. Aucun envoi réel effectué : l'adresse du propriétaire de dev n'est pas routable ; test d'envoi à faire vers une adresse réelle. |
| Push | **Actif sur Android, iOS/macOS en attente APNs** — Firebase Cloud Messaging HTTP v1 (projet `ravzo-fbe55`), OAuth signé côté serveur, jeton par appareil de confiance, montants masqués, lien profond. Vérifié en réel sur émulateur Android : notification reçue app en arrière-plan, « Paiement de ••• à confirmer », ouverture sur Activité. iOS/macOS : clé APNs (compte Apple Developer) requise. |
| Infra distribuée B38/B39, PITR, CI/CD | **BLOCKED externe** (pas de VPS) — voir `docs/runbooks/deployment.md` |
| iOS / Android | Android **lancé sur émulateur** (connexion, approbation d'appareil, accueil, push) ; iOS non lancé |

## Tâches (IDs du plan)
DONE (implémentées + vérifiées par tests) : FND-001…007, BACK-001…006, BACK-010…014, BACK-020…025, BACK-030…036, BACK-040…047, BACK-050…056, TEST-001.
DONE (implémentées + compilées, vérif. visuelle partielle) : FRONT-001…014, INT-001 (connexion → enrôlement → accueil réel, vérifié à l'écran), création de compte (vérifiée à l'écran).
DONE (cliqués de bout en bout dans l'app macOS) : paiement simulé (compte bac à sable → bénéficiaire non vérifié → récapitulatif → confirmation renforcée → signature de l'appareil → « En cours » → webhook signé → « Réussi » mis à jour en direct) ; anomalie de rapprochement visible puis résolue (écriture compensatoire signée, balance débloquée) ; paiement au-delà du plafond → demande de dérogation signée → envoi refusé avant 72 h, y compris depuis la fiche du paiement ; résultat incertain (délai dépassé) → aucun nouvel essai, réservations conservées → vérification de statut en lecture → « Réussi » ; INT-002 revenu → répartition → confirmation ; INT-003 création de coffre → versement → demande de retrait signée (refus métier correct : capacité 0 car versement < 72 h).
TEST-002 : 5 tests Flutter (formatage XOF, masquage, étiquettes, Loader erreur/page) verts — pas encore de tests de parcours (integration_test).
TEST-003 : vérifiés à l'écran — sombre et clair sur grand écran, disposition mobile (largeur étroite : navigation inférieure, une colonne, pas de débordement), persistance des préférences au redémarrage. Non vérifiés : reduce-motion, simulateur iOS / émulateur Android, contrastes mesurés.
BLOCKED : paiements live, BRVM licenciée, clé APNs (push iOS/macOS), envoi e-mail réel (adresse de test), B38/B39/PITR/CI (accès externes requis).

## Preuves exécutées
- `npm test` (backend) : 4 suites, **36/36** — T01–T18, T20, T22–T26 couverts (voir traçabilité). Une exécution antérieure a montré 1 échec non reproduit (probable épuisement des retries SERIALIZABLE sous T02) → budget de retries porté à 8 ; 3 exécutions suivantes vertes.
- Démarrage réel API + worker : jobs planifiés exécutés via BullMQ (logs), OpenAPI servi.
- App macOS : connexion réelle, enrôlement par code d'initialisation, SSE « temps réel » connecté, ajout d'un compte reflété sur l'accueil, écrans Argent / Épargne / Patrimoine / Activité affichés avec données réelles.

## Défauts trouvés et corrigés pendant la session
- Base du plafond 20 % comptant deux fois les réservations (ADR-003).
- Réponses binaires (PDF, documents) sérialisées en JSON par l'intercepteur.
- Clé unique des versements empêchant deux versements manuels le même jour (`slotKey`).
- Grille de widgets de l'accueil en une colonne sur grand écran (LayoutBuilder).
- Écrans de détail plein écran vides (Scaffold dans une Column non bornée) : `Loader(page: true)`.
- Contraste : texte blanc sur menthe dans les segments sélectionnés (thème sombre) ; thèmes explicites segments/interrupteurs.
- Suggestion de versement = toute la cible restante au lieu du prochain versement prévu (test ajouté).
- **Grave (corrigé)** : le worker interrogeait sa propre instance du prestataire simulé, obtenait « introuvable » et marquait le paiement ÉCHOUÉ en libérant ses réservations ; le succès réel arrivé ensuite était ignoré. Désormais « introuvable » n'est jamais une preuve de non-exécution, et tout événement contredisant un état terminal ouvre une anomalie et bloque la balance (test ajouté).
- Flux temps réel non reconnecté après une nouvelle connexion (poignée SSE non réinitialisée).
- Raisons de rapprochement et états affichés en codes bruts → libellés français.
- Écart d'un cas « succès après échec » exprimé avec de mauvais montants (correction impossible ou à 0) → exprimé en mouvement du compte ; la résolution réintègre aussi le paiement dans la fenêtre de plafond 24 h (tests ajoutés).
- Le job horaire de rapprochement aurait bloqué les balances du bac à sable (solde inconnu de l'instance du worker) → un solde inconnu du prestataire n'entraîne plus de comparaison.
- Aucun moyen de valider plus tard un paiement « À confirmer » (ex. après le délai d'une dérogation) → action « Valider et envoyer » sur la fiche ; le récapitulatif n'invite plus à demander une seconde dérogation.
- Catégorie de revenu par défaut et compte unique présélectionnés dans l'assistant ; explication de l'exclusion des versements < 72 h dans la demande de retrait.

## Risques résiduels / non vérifié
- Builds de débogage macOS : chaque reconstruction change la signature ad hoc, macOS redemande l'accès au trousseau (sans conséquence pour une version signée).
- Données de dev : le paiement simulé marqué ÉCHOUÉ avant correctif a son cas résolu ; son montant n'a pas été réintégré dans la fenêtre 24 h (résolu avant ce correctif ; une ligne de cas a été rectifiée en base de dev pour suivre la nouvelle convention).
- T19 (restauration PITR) et T21 (réplica en retard) : non testables sans topologie réelle ; le code n'utilise jamais `reader` pour une décision financière (revue manuelle).
- Pas de tests E2E Flutter ; pas de test d'accessibilité (contrastes AA non mesurés).
- Polices Sora/Inter chargées via `google_fonts` (réseau au premier lancement, repli système hors ligne) ; à embarquer avant distribution.
- L'en-tête `Idempotency-Key` des intentions de paiement repose sur une clé dérivée côté client par écran ; à durcir (clé persistée par brouillon).
- Rétention/purge documentaire (backend.md §17) : suppression + tombstone d'audit faites, durées légales non définies (dépend du droit béninois).

## Prochaines actions
1. Tests de parcours Flutter (integration_test). Activation réelle d'une dérogation après 72 h non observable à l'écran (horloge serveur réelle) — couverte par T09.
2. Simulateur iOS / émulateur Android, reduce-motion, mesure des contrastes AA.
3. Embarquer les polices ; icônes d'application RAVZO.
4. Infra : VPS, Compose multi-hôte, sauvegardes WAL/PITR + exercice T19, CI.
5. Étude contractuelle PSP (FeexPay/FedaPay/KKiaPay) puis adaptateur réel en sandbox officielle.
