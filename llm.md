# LLM.md — Application privée de finances personnelles

> **Document maître de conception et d'implémentation**  
> **Version :** 1.0 — 14 novembre 2026  
> **Plateformes :** iPhone (iOS), Android, macOS  
> **Produit :** application privée, mono-utilisateur, synchronisée entre les appareils autorisés  
> **Identité visuelle validée :** Calm Wealth — Expressive Edition  
> **Décisions de référence :** D01–D75 (métier), UX01–UX24 (expérience utilisateur).  
> **Statut :** directives consolidées pour réalisation ; les intégrations de paiement restent conditionnées à une vérification juridique, contractuelle et technique.

---

## 0. Rôle de ce document et mode d'emploi pour une IA de développement

Ce document constitue la **source d'instructions principale** pour tout agent IA, développeur, designer ou réviseur intervenant sur le projet. Il décrit l'intention du produit, les règles non négociables, les parcours utilisateurs, le design system, l'architecture cible, les données, les contrôles et les critères de livraison.

**Principes d'exécution :**

1. Ne jamais confondre les **75 décisions métier validées** et les **24 décisions UX validées** avec des recommandations techniques : la première catégorie est obligatoire ; la seconde est obligatoire pour l'expérience ; la stack proposée reste une base à confirmer contre la faisabilité réelle.
2. **Ne pas inventer de capacités PSP, d'API de courtage, de cotations temps réel ou de verrouillage réglementé des fonds.** Les connecteurs incertains restent désactivés jusqu'à validation.
3. Conserver un fonctionnement utile **sans paiement réel** : registre personnel, revenus/dépenses, budgets, coffres de discipline, dettes, patrimoine et portefeuille BRVM manuel.
4. Prioriser l'intégrité comptable, l'absence de doubles paiements, la sécurité et la transparence de la donnée ; les effets visuels ne doivent jamais fausser les statuts financiers.
5. Produire un produit réellement fonctionnel, pas seulement des écrans statiques ou des services simulés en production. Les mocks restent confinés à l'environnement de développement, aux tests et aux démonstrations explicitement signalées.
6. Conserver ce document comme référence centrale ; toute divergence doit être notée dans un journal des décisions, avec justification et approbation si une décision validée est impactée.
7. **Ne pas mélanger ce produit mono-utilisateur avec un autre projet de gestion financière à deux personnes.** Aucun module de co-validation entre partenaires ni patrimoine commun partagé n'est demandé ici.

### Convention de priorité

**Restrictions légales/prestataire et sécurité effective > intégrité des fonds/du registre > décisions métier D01–D75 > décisions UX UX01–UX24 > direction artistique validée > optimisations techniques.**

Une dérogation de plafond ne lève jamais une suspension de sécurité, un blocage de rapprochement, une restriction réelle de coffre ni les limites externes d'un fournisseur.

---

## 1. Vision et périmètre

### 1.1 Vision produit

Construire une application **personnelle, premium, expressive, très simple à utiliser et très complète à explorer**, permettant de piloter :

- les comptes et portefeuilles courants ;
- les revenus, dépenses et paiements Mobile Money quand autorisés ;
- les enveloppes virtuelles et coffres d'épargne avec objectifs et discipline de retrait ;
- les budgets liés à des cycles de revenus ;
- les dettes, créances, échéances, intérêts éventuels et remboursements ;
- les biens matériels et le patrimoine net ;
- les comptes espèces SGI et les investissements en titres de la BRVM ;
- les historiques, imports, rapprochements, graphiques et exports ;
- la sécurité, les appareils de confiance, l'activité sensible et les notifications.

**Devise principale : XOF (FCFA)**. Prévoir un modèle extensible multi-devises mais ne pas complexifier inutilement la V1 ; chaque compte et chaque mouvement conserve sa devise et ses éventuelles données de conversion. Fuseau d'affichage par défaut : **Africa/Porto-Novo**, avec stockage temporel UTC au serveur.

### 1.2 Périmètre de déploiement

- Une identité propriétaire du compte, avec plusieurs **appareils de confiance** (Mac, iPhone, Android) et sessions multiples sécurisées.
- Backend central, source de vérité comptable ; les clients sont des interfaces et caches synchronisés.
- Usage personnel et privé, non commercialisé comme établissement bancaire ou prestataire de services financiers.
- Tout transfert réel exige une **intégration officiellement permise et conforme** ; utiliser un compte marchand hors de son périmètre contractuel est interdit.

### 1.3 Non-objectifs V1

- Pas d'exécution d'ordres boursiers auprès d'une SGI depuis l'application ; achats/ventes saisis ou importés **après exécution externe**.
- Pas de promesse de fonds réellement bloqués sans contrôle effectif de l'infrastructure qui les détient.
- Pas de paiement automatiquement lancé par une recommandation IA, un budget, une notification, une tâche planifiée ou une synchronisation hors ligne.
- Pas de réseau social, collaboration familiale, multi-tenant public, ni organisation d'entreprise.
- Pas d'affirmation de statut temps réel si les données BRVM sont différées.

---

## 2. Direction artistique validée — Calm Wealth, Expressive Edition

### 2.1 Intention

**Warm Premium Fintech × Personal Wealth**, désormais en version **très expressive**. Design élégant, calme par la composition, chaleureux par les couleurs, vivant par le mouvement. Les nombreuses fonctions analytiques ne doivent **jamais** produire une interface visuellement chargée. L'esthétique exprime une personnalité claire et sophistiquée, non une application bancaire générique.

**Mots clés :** premium, épuré, très intuitif, analytique, chaleureux, expressif, intelligent, accessible, précis.

### 2.2 Palette validée

| Token | Clair | Utilisation |
|---|---|---|
| `brand.deepJade` | `#176356` | Identité, actions principales, navigation active |
| `brand.softMint` | `#A1E6CC` | Accent, progression, surbrillance douce |
| `surface.warmIvory` | `#F6F7F2` | Fond général clair |
| `text.mineralInk` | `#1D2B2A` | Titres, données, texte principal |
| `surface.sageMist` | `#E9F0ED` | Surfaces secondaires |
| `accent.softCopper` | `#D4A36A` | Accent chaleureux, décoratif avec contraste vérifié |
| `semantic.info` | `#365C91` | Informations |
| `semantic.warning` | `#94631A` | Avertissements |
| `semantic.error` | `#AD443F` | Échecs, actions destructrices |
| `semantic.neutral` | `#52625F` | État secondaire |

**Sombre :** fond `#111C20`, surfaces `#1A2B30`, texte principal `#F2F6F3`, secondaire `#B0C1BE`, accents menthe adaptés. Tester toutes les combinaisons de contraste ; les couleurs de marque ne garantissent pas à elles seules WCAG AA.

### 2.3 Typographies et nombres

- **Sora :** titres, identité, grands indicateurs et valeurs majeures.
- **Inter :** corps de texte, tableaux, contrôles, légendes et montants fonctionnels.
- Chiffres tabulaires pour colonnes et soldes susceptibles de se mettre à jour.
- Format usuel XOF : `150 000 FCFA` ; conserver signe, décimales éventuelles et unité sans ambiguïté.
- Taille de corps mobile recommandée 16 px ; préserver l'adaptation aux réglages d'accessibilité et à la taille du texte.

### 2.4 Composants et mise en page

- Marges et espacements fondés sur une échelle `4, 8, 12, 16, 20, 24, 32, 40, 48` px.
- Cartes standards rayons ~16–20 px, cartes vedettes ~22–24 px, boutons ~12–14 px, champs ~52 px de hauteur.
- Élévations sobres, bordures discrètes, séparation nette entre informations et actions.
- Le design **révèle progressivement** les options avancées ; l'écran principal reste lisible malgré sa richesse analytique.
- Une seule action principale par contexte ; les actions dangereuses sont visuellement distinctes et explicitement nommées.

### 2.5 Motion design : exigence majeure

L'utilisateur a explicitement demandé des **animations très expressives et un design très expressif**. L'ancienne formulation « animations discrètes » ne doit pas réduire cette ambition. Les animations sont riches et identitaires, mais toujours lisibles et contrôlées.

À prévoir :

- transitions de pages fluides, chorégraphies de cartes, apparition progressive de sections et éléments de navigation ;
- micro-interactions expressives des boutons, filtres, barres de progression et éléments sélectionnés ;
- animations d'objectifs d'épargne, états de réussite et transitions visuelles de tableaux de bord ;
- graphiques animés avec transitions entre périodes, survols desktop, explorations tactiles mobiles ;
- composants d'état financier expressifs sans suggérer un résultat non confirmé ;
- animations coordonnées lorsque la mise en page se réorganise ou qu'un filtre change ;
- variantes réduites ou sans mouvement si le système demande `reduce motion` ;
- éviter animations bloquantes, scintillements, compteurs de montants trompeurs, faux « live », distractions durant autorisation de paiement.

Techniques Flutter possibles à évaluer : animations implicites/explicites, `AnimationController`, `Hero`, `CustomPainter`, Rive pour composants identitaires à état, éventuellement Lottie pour animations non critiques. **Aucun package n'est obligatoire sans justification des performances, de la maintenance et de la licence.**

### 2.6 UX multiplateforme

- **iPhone/Android :** navigation inférieure, actions tactiles, formulaires guidés, feuilles de détails, états hors ligne visibles.
- **macOS :** sidebar, tableaux enrichis, raccourcis clavier, actions au survol, panneaux latéraux, fenêtres/dialogues adaptés, navigation clavier, import de relevés facilitée.
- Mêmes règles financières et même source de vérité sur toutes les plateformes ; compositions et interactions adaptées, pas une interface agrandie.
- Mode clair/sombre + suivi du système et préférence utilisateur persistée.

---

## 3. Architecture de l'information et décisions UX01–UX24

### 3.1 Navigation principale

**Cinq espaces principaux :**

1. **Accueil** — vue financière et analytique globale ;
2. **Argent** — comptes, revenus, paiements, budgets, dettes et créances ;
3. **Épargne** — coffres, programmes, versements et retraits ;
4. **Patrimoine** — biens, valeur nette, BRVM, SGI ;
5. **Activité** — historique, recherche opérationnelle, rapprochement, imports et exports.

En complément : accès global au **profil et centre de sécurité**, à la **recherche globale**, aux **notifications intelligentes**, et au **centre des opérations** (toujours accessible discrètement, avec indicateur uniquement si une intervention est nécessaire).

Ce découpage de navigation est la base d'implémentation globale approuvée ; ses micro-détails et le placement exact des contrôles peuvent être optimisés sans relancer de questionnaire.

### 3.2 Registre consolidé des 24 décisions UX

| ID | Décision UX validée | Traduction impérative |
|---|---|---|
| UX01 | Disponible conseillé en vedette | Solde réel confirmé visible et distinct |
| UX02 | Raccourcis adaptés automatiquement aux habitudes | Jamais de lancement automatique d'opération |
| UX03 | Accueil complet, statistiques et graphiques | Hiérarchie forte, pas de surcharge malgré la richesse |
| UX04 | Espace Argent hybride | Soldes/comptes + actions essentielles sur même espace |
| UX05 | Revenu en étapes guidées | Revenu → répartition → vérification/confirmation |
| UX06 | Paiement adaptatif au bénéficiaire/risque | Récapitulatif et forte authentification TOUJOURS |
| UX07 | Coffres en vue analytique | Graphiques et statistiques détaillées |
| UX08 | Détail coffre hybride | Résumé/actions visibles, autres infos en sections/onglets |
| UX09 | Budgets analytiques | Graphiques, catégories, prévisions, alertes |
| UX10 | Dettes/créances ensemble | Dashboard commun, filtres distincts, échéances |
| UX11 | Patrimoine hybride complet | Valeur nette, répartition, évolution, actifs/passifs |
| UX12 | BRVM complet | Portefeuille, marché, dividendes, projets, analyses |
| UX13 | Historique complet | Chronologie, recherche, filtres, graphiques, export |
| UX14 | Notifications intelligentes | Tri par urgence et habitudes ; critiques jamais masquées |
| UX15 | Centre de sécurité | Appareils, plafonds, sessions, dérogations, événements |
| UX16 | Interface intelligente personnalisable | Suggestions automatiques + contrôle manuel des widgets |
| UX17 | Offline explicite | Centre de sync + validation individuelle de chaque modification |
| UX18 | Adaptation native Mac/mobile | Sidebar/tableaux/raccourcis Mac ; tactile/guides mobile |
| UX19 | Recherche globale | Transactions, comptes, coffres, dettes, investissements, filtres |
| UX20 | Analyses avancées | Comparaisons, filtres croisés, périodes et exploration |
| UX21 | Centre des opérations commun | En attente, brouillons, incertain, interventions |
| UX22 | Onboarding progressif | Accès à l'application sans config complète obligatoire |
| UX23 | Masquage global des montants | Cohérence dashboard, listes, graphiques, détails et recherches |
| UX24 | Accès discret permanent aux opérations | Indicateur lorsque intervention nécessaire, pas 6e onglet |

### 3.3 Accueil

- Montant principal : **disponible conseillé** ; afficher dans le même contexte le **solde courant confirmé**, les éventuelles **restrictions de transfert** et la date de dernière synchronisation.
- Actions rapides personnalisées automatiquement selon les habitudes (avec accès stable aux autres fonctions).
- Widgets statistiques complets et réorganisables : budgets actifs, prévisions, coffres, dettes, BRVM, patrimoine, opérations récentes, événements urgents.
- Les alertes de sécurité et de cohérence financière sont fixes/prioritaires, même lorsque les widgets secondaires sont masqués ou déplacés.
- Les données doivent porter des labels : **confirmé**, **suivi manuellement**, **prévisionnel**, **estimé**, **différé**, **ancien** ou **à rapprocher** si applicable.

### 3.4 Onboarding et personnalisation

- Onboarding léger : présentation de l'application et connexion sécurisée, puis accès immédiat aux fonctionnalités ne nécessitant pas de prestataire.
- Ajouter comptes, revenus, coffres, budgets, SGI au fur et à mesure ; montrer des états vides élégants, explicites et actionnables.
- Réorganiser manuellement les widgets, avec suggestions fondées sur l'utilisation ; pas d'altération de données ni de permissions par un moteur de personnalisation.
- Bouton global **masquer/afficher les montants** ; prendre en compte tableaux, axes de graphiques, info-bulles, exports/partages et notifications (paramètres spécifiques). Le masquage n'est pas une mesure d'authentification ni un effacement de données.

### 3.5 Notifications et opérations : deux fonctions distinctes

- **Notifications :** informer, organiser intelligemment selon urgence et habitudes, sécuriser les catégories critiques.
- **Centre des opérations :** voir les brouillons, opérations en attente/incertaines, documents à vérifier, synchronisations à confirmer, dérogations et actions possibles. Ne jamais créer de bouton « réessayer » aveugle pour un paiement de résultat inconnu.

---

## 4. Architecture applicative cible

### 4.1 Proposition de stack

| Couche | Base proposée | Statut |
|---|---|---|
| Frontend universel | **Flutter / Dart** | Recommandée, cohérente avec plateformes |
| Backend | **NestJS / TypeScript**, monolithe modulaire | Recommandée |
| Base transactionnelle | **PostgreSQL** | Recommandée |
| ORM/migrations | Prisma (ou alternative compatible) | À figer à l'implémentation |
| Queue/planification | Redis + BullMQ | Recommandée pour jobs/reprises |
| Cache offline Flutter | SQLite/Drift ou équivalent chiffrable | À valider techniquement |
| Communication temps réel | SSE ou WebSocket + récupération périodique | À choisir sur critères réels |
| Notifications | APNs/FCM + service email autorisé | Selon configuration réelle |
| Hébergement | VPS privé + Docker Compose + reverse proxy HTTPS | Recommandé |

**Monolithe modulaire, pas microservices dispersés.** API et workers peuvent être lancés comme processus/conteneurs distincts en partageant les mêmes modules métier et la même base. Journal durable, observabilité, retries idempotents.

### 4.2 Modules backend

`identity`, `security`, `devices`, `accounts`, `ledger`, `wallets`, `income`, `payments`, `savings`, `budgets`, `liabilities`, `assets`, `investments`, `market-data`, `notifications`, `activity`, `imports`, `reconciliation`, `sync`, `integrations`, `analytics`.

Les règles transversales sont centralisées : sécurité dans `security`, intégrité financière dans `ledger`, opérations externes dans `payments`/`integrations`, restrictions de coffres dans `savings` avec contrôle sur le chemin de sortie réellement gouvernable.

### 4.3 Architecture Flutter

- Navigation typée, responsive et profonde (deep links internes sécurisés).
- Architecture par fonctionnalités (`features/accounts`, `features/payments`, etc.) avec séparation UI / state-management / cas d'utilisation / dépôts de données.
- Design system transversal : `foundations`, `primitives`, `financial-components`, `patterns`, `layouts`, `motion`.
- États chargement, vide, erreur, incertain, hors ligne, suspension et fonds restreints obligatoires.
- Mécanisme d'actualisation côté client qui **n'invente pas** une confirmation de paiement ; états canoniques issus du serveur.
- Cache local minimal chiffré pour les données sensibles, synchronisation explicite et traçabilité de l'horodatage.

### 4.4 Principes de sécurité technique

- Authentification robuste, limitation de débit, validation stricte de données, rotation et révocation des sessions.
- Appareil de confiance avec clé propre si techniquement possible (Keychain/Secure Enclave/Android Keystore) et preuve liée à la demande d'autorisation ; biométrie locale ne remplace pas une validation serveur.
- Pour les paiements, une autorisation cryptographiquement liée aux paramètres exacts et de courte validité ; changement montant/frais/destinataire → revalidation.
- Chiffrement en transit ; secrets PSP exclusivement côté serveur ; secrets chiffrés au repos ; gestion séparée des environnements.
- Journal de sécurité append-only/auditable ; ne pas y stocker de secrets, PIN ou données personnelles inutiles.
- Désactivation serveur immédiatement effective des appareils révoqués ; reconnaître l'impossibilité de supprimer à coup sûr le cache d'un appareil perdu et hors ligne.
- Restauration de données et de sauvegardes testée, avec réconciliation des événements externes avant de permettre des sorties après incident.

---

## 5. Noyau financier et modèles d'argent

### 5.1 Grand principe : argent réel vs information comptable

Le système possède au moins trois notions **non interchangeables** :

1. **Solde financier confirmé** : fonds sur un compte/balance, tels que rapprochés d'un prestataire ou d'une source fiable ; les comptes suivis manuellement sont identifiés comme tels.
2. **Affectation interne** : portion de fonds destinée au courant, à un coffre, à une obligation ou à un achat BRVM envisagé ; une affectation ne crée pas de cash réel.
3. **Disponible conseillé** : estimation de dépense raisonnable après déduction des réservations virtuelles, obligations et charges essentielles prévues, sans jamais être confondue avec le solde transférable effectif.

Ne jamais créer un deuxième revenu lors d'un transfert de compte, d'un dépôt de revenus déjà enregistrés ou d'un remboursement du principal d'une créance.

### 5.2 Registre comptable

- Journal immuable, écritures équilibrées à double entrée, références de corrélation externes, idempotence.
- Montants numériques **exactes en unités mineures ou décimal exact**, jamais `float` pour de l'argent ; XOF sans fraction dans l'usage courant, modèles extensibles.
- Capturer origine, destination, devise, montant brut, frais, montant net, prestataire, état, pièces, timestamps, auteur/appareil et identifiants externes.
- Les soldes affichés sont des projections vérifiables, régénérables à partir du registre ; rapprochement obligatoire avec sources externes quand possible.
- Une écriture confirmée se corrige par une écriture de compensation traçable, non par écrasement silencieux.
- Distinction entre **transaction exécutée**, **écriture financière confirmée**, **réservation de plafond**, **réservation virtuelle de budget** et **prévision**.

### 5.3 Entités logiques minimales

- `User`, `TrustedDevice`, `Session`, `RecoveryCredential`, `SecurityEvent`, `LimitPolicy`, `LimitChangeRequest`, `ExceptionAuthorization` ;
- `FinancialAccount`, `ProviderAccount`, `Wallet`, `Allocation`, `LedgerTransaction`, `LedgerPosting`, `BalanceSnapshot`, `ReconciliationCase` ;
- `Income`, `IncomeAllocation`, `Expense`, `Category`, `BudgetCycle`, `Budget`, `RecurringObligation` ;
- `PayinIntent`, `PayinAttempt`, `PayoutIntent`, `PayoutAttempt`, `Beneficiary`, `ProviderWebhook`, `PaymentHold` ;
- `SavingsGoal`, `ContributionPlan`, `PlannedContribution`, `SavingsWithdrawalRequest` ;
- `Debt`, `Receivable`, `LiabilitySchedule`, `Repayment`, `InterestAccrual` ;
- `PhysicalAsset`, `AssetValuation`, `Broker`, `BrokerageCashAccount`, `Security`, `HoldingLot/CostBasis`, `Trade`, `DividendAnnouncement`, `DividendEntitlement`, `DividendReceipt`, `PurchasePlan` ;
- `Notification`, `OfflineDraft`, `SyncReview`, `ImportBatch`, `ImportRow`, `DocumentAttachment`, `AuditEvent`.

Schéma détaillé, index, contraintes et relations sont à développer après vérification des flux, sans réduire ces obligations.

---

## 6. Comptes, revenus et dépenses

### 6.1 Comptes

- Gestion hybride des fonds détenus via PSP autorisé et des comptes externes suivis manuellement.
- Comptes d'espèces SGI séparés par courtier ; ne jamais double compter compte espèces et valeur des titres.
- Les enveloppes internes n'impliquent pas automatiquement des sous-comptes réels chez un PSP.
- Solde total patrimonial, liquidité et disponible conseillé distincts.

### 6.2 Revenus

- Pour chaque revenu, choix entre **Payin réel** (quand autorisé) et **suivi externe**.
- Répartition **manuelle**, avec suggestions automatiques modifiables. Confirmation explicite obligatoire.
- **D49 : un Payin distinct pour chaque destination à financer**, sans dupliquer le revenu économique source.
- Entrée du montant « total débité » ou « net à créditer », avec simulation transparente de frais et rapprochement du montant réellement versé.
- Payin multiples **séquentiels**, jamais lancés simultanément ; attendre état définitif avant le suivant.
- En cas d'échec définitif, suspendre les suivants, conserver les dépôts confirmés et demander une décision explicite de reprise.
- Indisponibilité PSP : attendre, informer quand revenu, nouvelle confirmation avant reprise ; ne pas substituer silencieusement un fournisseur ou une transaction fictive.

### 6.3 Dépenses et budgets

- Dépenses enregistrables manuellement et par imports facultatifs ; catégorisation proposée automatiquement avec modification libre.
- Budgets par catégories, **alignés sur cycles de revenus** et non obligatoirement mois calendaires.
- Ouverture de cycle manuelle, durée suggérée ; revenus additionnels rattachés au cycle en cours.
- Clôture automatique à date planifiée ; entre cycles, opérations **hors cycle** enregistrées puis proposition de rattachement au prochain cycle sur approbation, sans réécrire un cycle clôturé.
- Avertir avant dépassement de budget mais **ne pas bloquer** un paiement pour dépassement budgétaire seul.
- Réserver virtuellement charges essentielles, prévisions et obligations dans le **disponible conseillé** ; ne pas empêcher les paiements sur cette seule base.
- Charges récurrentes prévues et rappelées ; paiement effectif exige confirmation. Éviter double comptage charge prévue/transaction acquittée.

---

## 7. Coffres d'épargne et discipline

### 7.1 Configuration obligatoire

Chaque coffre définit : **montant cible, échéance, programme de contribution**. Le programme peut être une cadence calendaire fixe ou lié à la réception d'un revenu.

- Les versements sont **préparés/suggérés, jamais effectués automatiquement**.
- Le suivi des contributions manquées et les plans de rattrapage sont proposés, jamais imposés.
- À échéance sans objectif atteint, conserver le coffre et sa protection ; signaler retard et proposer replanification confirmée.
- À atteinte de la cible, aucune libération automatique ; décision explicite et délai de 72 heures pour un déblocage ordinaire.

### 7.2 Sorties

- Délai de **72 heures** pour les demandes de retrait exceptionnel et pour le déblocage ordinaire après objectif atteint.
- Retrait exceptionnel max **20 % sur une fenêtre glissante de 30 jours** ; calcul sur une **base reconstituée**, retraits exécutés et réservations de demandes en attente inclus pour empêcher les demandes concurrentes ou fractionnées abusives.
- Prévenir les manipulations de base via reclassification/transferts artificiels, corrections historiques ou modifications d'objectif ; les conventions de calcul exactes doivent être précisées dans la logique d'implémentation et testées.
- Le paiement externe sort **du portefeuille courant** : si les fonds sont réellement cloisonnés, le transfert coffre → courant doit d'abord respecter la règle effective de déblocage.
- **Crucial D48 :** si l'infrastructure PSP ne garantit pas la restriction, les délais et interdictions de retrait sont **indicatifs**. Afficher sans ambiguïté « discipline indicative, fonds non immobilisés techniquement ». Ne jamais promettre un blocage matériel du fonds.

---

## 8. Paiements réels, plafonds et dérogations

### 8.1 Principes PSP

- Priorité au **Mobile Money** dans les intégrations disponibles et officiellement autorisées ; prévoir adaptateurs interchangeables sous contrat commun.
- Bénéficiaires sauvegardés : nom de contact, téléphone normalisé, opérateur ; vérifier nom officiel si API officiellement disponible, sinon avertir et exiger contrôle renforcé, tout en permettant l'opération selon D14.
- Il est interdit d'assimiler le nom d'un contact local à une vérification officielle.
- Toutes plateformes de confiance peuvent initier un payout (Mac inclus) après forte authentification **par opération**.
- Le payout ordinaire part **exclusivement du portefeuille courant**.
- Paiements inconnus : statut `unknown`, investigations automatiques, montant/plafond réservé ; aucune seconde tentative tant que le premier résultat n'est pas clarifié.
- Les statuts reçus par webhook sont authentifiés et traités de façon idempotente, tolérant doublons, désordre et retard des événements.

### 8.2 Plafonds confirmés

- **30 000 FCFA maximum par opération**.
- **60 000 FCFA maximum sur 24 heures glissantes**.
- **Montant intégral débité, frais inclus**.
- Ils concernent **tous les transferts sortants vers des comptes externes**, qu'il s'agisse de tiers ou de comptes personnels de l'utilisateur, y compris les envois vers comptes SGI lorsque réalisés par l'application.
- Ne concernent pas les simples mouvements d'affectation interne sans sortie externe.
- Les paiements en attente réservent la capacité, de manière atomique et multi-appareils ; ne jamais double compter réservation et règlement confirmé.
- Annulation certaine **avant exécution** libère la réservation ; paiement réellement exécuté puis remboursé **compte quand même sur 24 heures**.
- Un paiement au statut inconnu ne libère pas sa réservation sur simple timeout. Rapprocher avant libération.
- Baisse des plafonds **immédiate** ; hausse ordinaire dans les seuils de référence effective après **48 heures** ; hausse **au-delà** des références nécessite **72 heures**.
- Les modifications sont contrôlées par horloge serveur, fortes authentifications, journaux et protection contre concurrence.

### 8.3 Exception pour grosse dépense

- Procédure dédiée avec **72 heures de délai renforcé**.
- Autorisation liée **à une seule opération précise**, avec montant maximal, identité du bénéficiaire ou contraintes équivalentes, durée d'utilisation **24 heures après activation** et usage unique.
- Nouvelle confirmation finale + forte authentification, paramètres revalidés si modifiés.
- Ne peut **jamais** lever une suspension post-récupération, une anomalie de solde, une restriction effective de coffre, ou les plafonds du prestataire.
- Tentatives, rejets, révocations, consommations et expirations auditables.

### 8.4 Machine d'états de paiement recommandée

`draft → awaiting_confirmation → authorized → reserved → submitted → processing/pending → succeeded | failed | cancelled | unknown`

`unknown` n'est **pas** un échec. Il peut évoluer vers un état définitif après rapprochement. Les transitions sont interdites sans preuves requises, avec horodatage et historique. Une réponse réseau absente après soumission ne provoque jamais de second débit.

### 8.5 Concurrence et idempotence

- Chaque demande client possède une clé unique stable ; verrouillage atomique/transactions SQL pour plafond, solde, autorisation de sécurité et état de l'intention.
- Une clé de tentative PSP ne doit pas être régénérée aveuglément après timeout. Vérifier capacités de référence et idempotence effectives du fournisseur.
- Prévoir vérification périodique, backoff raisonnable, gestion des quotas, alertes d'exploitation et réconciliation différée.

---

## 9. Rapprochement et anomalies

- Comparer registre interne et soldes vérifiables du prestataire à partir d'instantanés datés.
- Écart non expliqué : **bloquer les sorties de toutes les enveloppes utilisant la balance réelle concernée** ; préserver les balances réellement indépendantes.
- Continuer à recevoir et comptabiliser les événements entrants/confirmations côté serveur pendant le blocage.
- Identifier frais, paiements manquants, ordres d'événements, retards PSP, réaffectations, imports en double.
- Proposer correction **traçable** : écriture compensatoire, attribution de source, pièce et événement d'audit ; pas d'alignement silencieux.
- Les notifications et le centre d'opérations signalent les interventions nécessaires sans prétendre résoudre automatiquement un différend avec le fournisseur.

---

## 10. Dettes, créances et obligations futures

- Gérer dettes contractées, créances détenues et engagements futurs non assimilés à un emprunt.
- Échéancier possible avec ou sans intérêts ; remboursements partiels et paiements uniques ; intérêts et frais distincts du principal.
- Un emprunt reçu augmente simultanément trésorerie et passif, **pas le revenu gagné**.
- Rembourser le principal diminue cash et dette, sans double comptabiliser une « dépense économique » ; intérêts et commissions peuvent constituer une charge.
- Si une transaction semble correspondre à un remboursement, suggérer un rapprochement et demander confirmation explicite.
- Retards, rappels, nouvelles échéances et historique conservé ; ne pas falsifier le contrat ou prétendre qu'un tiers a approuvé une replanification.
- UX : tableau de bord commun avec filtres dettes/créances, échéances, tendances et alertes.

---

## 11. Patrimoine et BRVM

### 11.1 Patrimoine physique

- Inclure comptes financiers, titres détenus, biens significatifs (immobilier, véhicules, équipement), moins dettes et autres passifs.
- Valeur historique avec changements datés et provenance de l'estimation ; ne pas transformer réévaluation en revenu encaissé.
- Historique et graphiques de valeur nette, avec séparation actifs/liquidités/passifs et précautions contre double comptage.

### 11.2 Comptes SGI et titres

- Comptes espèces séparés par SGI, avec entrées, sorties, dividendes crédités et frais.
- Achats/ventes **saisis manuellement ou importés de documents SGI** ; pas d'ordres de bourse exécutés par l'application.
- Journal des opérations : sécurité/titre, quantité, prix, date d'exécution, courtier, commissions/taxes documentées, coût de revient, cessions, dividendes, P&L réalisé/non réalisé.
- Méthode de prix de revient : priorité méthode justifiée de la SGI, sinon méthode de repli **explicitement identifiée comme indicative** ; ne pas présenter une base fiscale officielle non vérifiée.
- Dividende annoncé : événement/attente ; ne pas créditer l'espèce avant preuve de versement, rapprochement et droits du portefeuille.
- Projets d'achat avec **réservation virtuelle seulement**, pas titres acquis ni ordre externe.
- Cours BRVM horodatés ; si API indisponible ou quota épuisé, afficher dernier cours connu et son âge ; ne jamais afficher « live » à tort.
- UX complet : portefeuille personnel, marché, favoris, comparaisons, projets, dividendes, objectifs, alertes et analyses.

### 11.3 Source de marché

- Implémenter un contrat de fournisseur de marché remplaçable ; vérifier droits, autorisations, coûts, quotas, fraîcheur et couverture de chaque source **avant sélection définitive**.
- Identifier les cours officiels, les données agrégées, les estimations et la date de séance.
- Dégradation élégante lorsque données indisponibles, sans écraser les prix de revient personnels ni effacer positions.

---

## 12. Authentification, appareils et récupération

- Appareils multiples de confiance. Nouvel appareil approuvé par un appareil déjà fiable, ou par récupération intégrale sécurisée si aucun n'est disponible.
- Récupération complète avec codes de secours, révocation possible d'appareils/sessions et **suspension de 48 heures**.
- Pendant suspension : **consultation seule pour les modifications financières** ; actions strictement nécessaires à la sécurité (révocation) accessibles, et messages prestataires déjà engagés traités côté serveur.
- Notification push et email pour événements sensibles : nouveau device, récupération, demandes de plafond, dérogations, paiements et anomalies.
- Forte authentification **à chaque payout**, contrôles adaptatifs renforcés sur nouveau bénéficiaire, montant élevé, nom non vérifié ou appareil suspect.
- Ne jamais permettre à un appareil hors ligne ou à une simple biométrie locale de contourner le serveur.

---

## 13. Fonctionnement hors ligne et synchronisation

### 13.1 Offline autorisé

- Afficher données locales avec horodatage « dernière actualisation ».
- Créer et modifier des **brouillons préparatoires** de revenus, dépenses, objectifs et informations personnelles compatibles.
- Ne **jamais** exécuter payout, payin ni autorisation sensible hors ligne.

### 13.2 D44 — confirmation individuelle stricte

Chaque modification préparée hors ligne doit être présentée et **confirmée individuellement** avant sa synchronisation vers le serveur, même en absence de conflit.

- Versions/revisions, identifiants stables, déduplication et validation serveur.
- Conflit : conserver original serveur et brouillon local, afficher différence, demander une résolution explicite. Ne pas écraser une transaction financière confirmée.
- Événements reçus du PSP ou rafraîchissement de lecture n'exigent pas ces confirmations : seuls les changements initiés localement hors ligne sont concernés.

### 13.3 Temps réel

- Diffuser mises à jour de projections après commit serveur ; utiliser un curseur/version monotone pour récupérer les événements manquants.
- Le temps réel améliore le confort sans devenir la seule garantie de cohérence : à reconnexion, récupération complète des deltas et comparaison de version.

---

## 14. Notifications, recherche, analyses et export

### 14.1 Notifications intelligentes

- Classification par urgence/habitudes, sans dissimuler événements de sécurité, paiements incertains, écarts de solde, échéances critiques.
- Canaux : push et email pour événements sensibles ; préférences pour rappels et informations secondaires.
- Les notifications ne sont jamais des ordres de paiement et ne révèlent pas de montants si la politique d'écran verrouillé les masque.

### 14.2 Recherche et historique

- Recherche globale par terme, montant, dates, catégories, compte, bénéficiaire, statut, coffre, dette, valeur et titre BRVM.
- Historique complet des opérations avec filtres croisés, graphiques et export CSV/PDF. Protéger exports par contrôle d'accès, journaux et rappel de confidentialité.
- Maintenir les liens vers écritures sources et preuves PSP, même lorsqu'une vue masque certains champs.

### 14.3 Analyses avancées

- Comparaison de cycles, catégories, objectifs, disponibilité, évolution patrimoine net et performance des titres.
- Filtres croisés, périodes personnalisées, exploration « du graphique vers les transactions ».
- Séparer montants confirmés / comptabilisés manuellement / estimations / prévisions / cours différés, avec unités et dates toujours visibles.

---

## 15. Écrans fonctionnels à couvrir

Ne pas interpréter cette liste comme 1 route pour chaque item : plusieurs étapes peuvent devenir des panneaux, feuilles modales ou étapes de flux selon plateforme.

### Accès et sécurité

- Connexion ; enregistrement et validation du nouvel appareil ; récupération ; suspension de 48 h ; appareils/sessions ; paramètres sécurité ; limites ; dérogations ; journal d'audit.

### Accueil et Argent

- Accueil analytique configurable ; tableau des comptes ; détail compte ; ajout compte externe ; nouveau revenu ; répartition ; séquence Payin ; nouveau paiement ; bénéficiaires ; vérification d'identité ; récapitulatif/forte authentification ; suivi paiement ; dépense manuelle.

### Budgets, dettes

- Tableau budget/cycle ; ouverture et clôture de cycle ; budgets par catégories ; charges récurrentes ; dettes/créances ; nouvelle obligation ; échéancier ; remboursement et rapprochement.

### Épargne

- Dashboard analytique des coffres ; création de coffre ; détail hybride ; programme ; contribution ; demande de retrait ; suivi de délai ; replanification.

### Patrimoine et BRVM

- Valeur nette ; biens ; fiche et réévaluation ; portefeuille actions ; marché et fiche titre ; positions ; compte espèces SGI ; opération de courtage ; import d'avis ; dividendes ; projets d'achat ; alertes.

### Activité et outils globaux

- Historique et détail ; imports/contrôle des doublons ; rapprochement ; recherche globale ; centre notifications ; centre opérations ; mode privé montants ; centre sync ; validation individuelle des brouillons ; préférences et personnalisation.

**Chaque vue doit disposer d'une fiche de conception implémentable** : ID/route, intention, informations obligatoires, structure, hiérarchie, CTA, parcours, validations, cas vides/hors ligne/erreur, états d'autorisation, données API et accessibilité. Ne pas inventer des fausses données de production.

---

## 16. Contrats d'API et intégrations

### 16.1 Convention API

Recommandation : API versionnée `/api/v1`, schémas documentés OpenAPI, DTO stricts, pagination curseur pour historique, timestamps ISO 8601 UTC, erreurs structurées, identifiant de corrélation et idempotency key pour commandes sensibles.

**Exemples de familles**, à affiner pendant implémentation :

- `/identity`, `/devices`, `/sessions`, `/recovery`, `/security-events` ;
- `/accounts`, `/wallets`, `/balances`, `/ledger`, `/allocations` ;
- `/income`, `/expenses`, `/budgets`, `/cycles`, `/recurring-obligations` ;
- `/payments/payin`, `/payments/payout`, `/payments/:id`, `/beneficiaries` ;
- `/savings/goals`, `/savings/contributions`, `/savings/withdrawal-requests` ;
- `/liabilities`, `/repayments`, `/assets`, `/valuations` ;
- `/investments/brokers`, `/investments/trades`, `/investments/holdings`, `/market`, `/dividends`, `/purchase-plans` ;
- `/notifications`, `/operations-center`, `/activity`, `/imports`, `/reconciliation`, `/sync`.

Ne pas exposer directement d'endpoints permettant de modifier un solde ; modifications par commandes métier validées avec écritures comptables.

### 16.2 Adapter PSP obligatoire

L'interface fournisseur doit encapsuler :

- capacités réelles disponibles par opérateur/pays/contrat ;
- estimation des frais avec limites et avertissement ;
- création Payin/Payout, identifiant d'idempotence et référence interne ;
- suivi de statut, validation de webhook, rapprochement de fonds ;
- vérification du bénéficiaire uniquement si officiellement supportée ;
- informations sur les balances, sous-comptes, restrictions et retraits **uniquement si légalement et techniquement garanties** ;
- disponibilité/quotas/limites et erreurs normalisées.

**FeexPay, FedaPay, KKiaPay et autres acteurs ne sont que des candidats éventuels** : aucune activation sans étude actuelle du contrat, des capacités de comptes personnels ou marchands, du portage des fonds et de la possibilité d'alimenter des Payout via les ressources autorisées.

### 16.3 Adapter BRVM

`MarketDataProvider` capable de fournir cours, dates/horaires, annonces et identifiants des titres selon les droits disponibles ; provenance et fraîcheur persistées. Toute collecte est conforme aux licences/conditions d'utilisation. Pas de scraping interdit ou reproduction non autorisée.

---

## 17. Plan de réalisation, priorités et dépendances

### Phase 0 — Vérification des prérequis

- Choisir environnement Flutter/macOS/iOS/Android, signer les applications, backend et hébergement ;
- faire l'inventaire des capacités contractuelles et coûts réels PSP et sources de marché ;
- documenter limitations externes et expérience de repli.

### Phase 1 — Fondations fiabilisées

- Identité, appareils, sécurité, base PostgreSQL, journal à double entrée, règles montants/devises, tests d'invariants et design system Calm Wealth Expressive.

### Phase 2 — Fonctionnalités personnelles utilisables sans PSP

- Comptes externes, revenus, dépenses, budgets, charges, dettes, créances, cache offline, historique, graphiques et exports.

### Phase 3 — Épargne et discipline

- Coffres, objectifs, programmes, retraits, calcul roulant 30 jours, disponibilité conseillée, transparence des restrictions indicatives.

### Phase 4 — PSP autorisés et sécurité transactionnelle

- Sandbox réelle du prestataire, webhooks, rapprochement, holds, plafonds 30k/60k, dérogations 72h, bénéficiaires, scénarios d'incertitude, revue juridique/contractuelle ; activation progressive seulement après vérification.

### Phase 5 — Patrimoine et BRVM

- Actifs, réévaluations, comptes SGI, achats/ventes enregistrés, dividendes, données de marché licites, projets et alertes.

### Phase 6 — Durcissement et livraison

- Tests E2E Mac/iPhone/Android, performances des animations, accessibilité, imports, synchronisation, sauvegarde/restauration, monitoring, parcours catastrophes, distribution privée signée.

Il est acceptable de livrer une V1 avec paiements réels désactivés tant que les exigences externes ne sont pas satisfaites ; ce statut doit être explicite dans l'application et la documentation.

---

## 18. Critères d'acceptation et tests non négociables

### 18.1 Invariants de finance

- Total du journal à double entrée équilibré par devise et transaction.
- Aucune création de richesse suite à un transfert interne, un remboursement de principal, une réévaluation non réalisée ou un dividende seulement annoncé.
- Aucun solde confirmé modifié sans événement source et piste d'audit.
- Les réservations budgétaires ne se font pas passer pour des fonds immobilisés.
- Une balance PSP commune ne doit pas être dupliquée par chaque portefeuille interne.

### 18.2 Paiements

- Deux taps simultanés, deux appareils concurrents ou webhook répété ne causent jamais deux payouts pour une seule intention.
- Débit total (y compris frais) conforme aux limites atomiques par opération et sur 24h.
- Statut incertain ne libère pas le plafond et ne déclenche pas d'essai automatique.
- Paiement exécuté remboursé continue de compter pendant sa fenêtre 24h ; annulation certaine pré-exécution libère hold.
- Dérogation unique après 72h, expire après 24h, non transférable à un autre paiement, sans contournement de D43/D66.
- Les Payins multi-destinations sont séquentiels, avec pause en cas d'échec définitif.
- Aucun paiement effectué hors ligne ou pendant suspension de sécurité.

### 18.3 Épargne

- Retrait exceptionnel respecte 20 % reconstitués sur 30 jours, y compris demandes parallèles.
- Objectif atteint ne débloque pas seul le coffre ; 72h pour demande applicable.
- Objectif en retard ne supprime ni coffre ni protection.
- Statut « protection indicative » explicite quand PSP ne peut pas physiquement bloquer.

### 18.4 Synchronisation

- Chaque modification offline est présentée pour confirmation avant envoi, même sans conflit.
- Les événements serveur confirmés ne sont pas réécrits par de vieux caches.
- On peut toujours lire les opérations confirmées après reconnexion et reprendre les changements non soumis.

### 18.5 BRVM/patrimoine

- Dividend announcement != dividend receipt ; aucun cash crédité avant confirmation.
- Achat planifié != titre détenu ; réévaluation != argent encaissé.
- Dates de cotation fiables, cours ancien signalé, prise en charge du fournisseur indisponible.
- P&L distingue coûts, frais et opérations réelles.

### 18.6 UX/accessibilité

- Tous les parcours critiques fonctionnent au clavier sur Mac et au toucher mobile.
- Le masquage des montants protège toutes les vues sensibles prévues.
- Le design reste lisible malgré tableaux de bord complets et graphiques avancés.
- Les animations expressives sont fluides, non bloquantes et dégradées proprement si réduction des mouvements.
- États vides, erreurs, attente, hors ligne, suspicion et blocage disposent de messages clairs.

### 18.7 Sécurité et exploitation

- Sessions expirées/révoquées rejetées ; récupération complète entraîne 48h de restrictions serveur.
- Aucun secret PSP ou mot de passe en texte clair dans code client, logs ou exports.
- Sauvegardes chiffrées avec tests réels de restauration, cohérence du registre et récupération des événements prestataires.
- Observabilité sur échec de rapprochement, webhooks non confirmés et mouvements anormaux.

---

## 19. Recommandations d'exécution pour agents IA

### Avant de coder

1. Lire **tout** ce document ; lister les dépendances réelles et les contraintes non vérifiées.
2. Proposer une architecture détaillée et une matrice de traçabilité `Dxx / UXxx → module → test`.
3. Décider des détails techniques secondaires sans relancer une longue série de questionnaires ; demander une clarification uniquement sur un choix réellement bloquant ou un risque de modification des décisions validées.
4. Documenter les risques PSP, données BRVM, sous-comptes, restrictions réelles et signature iOS ; ne pas déclarer « prêt en production » sans preuve.

### Pendant le développement

- Prioriser invariants, schémas, migrations, services métier et tests ; brancher progressivement les écrans expressifs.
- Utiliser transactions atomiques/locks adaptés, commandes idempotentes et journal durable.
- Garder composants UI indépendants des clés et SDK PSP ; tous les paiements réels transitent par le serveur.
- Éviter toute fonctionnalité fantôme : boutons inertes, succès fictifs, données exemple présentées comme réelles.
- Documenter APIs, machines d'états, règles de sécurité et modes dégradés.

### À chaque livraison

Inclure : modifications, décisions couvertes, tests exécutés, limites restantes, fonctionnalités PSP réellement opérationnelles, captures/contrôles d'accessibilité si pertinents, et procédures de déploiement/reprise.

---

## 20. Points de faisabilité à lever sans rouvrir arbitrairement le métier

Les décisions métier et UX sont **validées** ; ce qui suit désigne des obstacles techniques ou juridiques à traiter, pas une nouvelle session de vote :

1. Capacité contractuelle d'un PSP au Bénin à accepter un usage personnel ou structure autorisée ; origine et détention des fonds ; Payin/Payout, reversement et limites.
2. Vérification officielle du nom bénéficiaire et réelle séparation des balances et coffres.
3. Définition exacte du calcul de base du plafond d'épargne D72 et des réservations concurrentes, avec scénarios de tests adversariaux.
4. Convention temporelle précise du plafond glissant 24h, notamment horodatage autorisation/exécution et rapprochement tardif, de façon à empêcher tout contournement.
5. Source BRVM licite, durable, fraîcheur, coût, quota, droits et changements de données.
6. Stratégie de signature et installation privée iPhone et Mac sur la durée, sauvegarde de données et protection du cache local.
7. Coût d'hébergement et maintenance proportionnés à un projet privé mono-utilisateur.

**Règle :** si un prérequis externe échoue, livrer honnêtement un mode suivi/discipline avec la fonctionnalité réelle désactivée, sans falsifier le résultat.

---

## 21. Définition de terminé

Le projet est considéré comme **fonctionnellement livré** lorsque :

- toutes les fonctions de suivi financier, budgets, épargne, dettes, patrimoine et portefeuille BRVM manuel sont utilisables sur les trois plateformes ;
- la synchronisation, le mode hors ligne avec approbation, les sauvegardes et l'authentification ont passé les tests d'acceptation ;
- le design Calm Wealth — Expressive Edition est cohérent, complet et expressif, avec performance et accessibilité suffisantes ;
- le registre financier satisfait ses invariants et aucun échec réseau ne peut créer de double débit ;
- les integrations externes sont soit réellement testées et officiellement autorisées, soit **clairement marquées indisponibles/non activées** ;
- les historiques, recherches, analyses, exports, alertes et sécurités respectent D01–D75 et UX01–UX24 ;
- la documentation d'installation, d'exploitation, de restauration et des limites connues accompagne la livraison.

**Phrase directrice du produit :** *« La puissance d'un outil financier complet, dans une expérience personnelle fluide, élégante et intensément expressive — sans compromis sur la vérité des chiffres et la sécurité de l'argent. »*
