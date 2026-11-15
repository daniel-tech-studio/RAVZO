# ADR-003 — Base du plafond de retrait exceptionnel (20 % / 30 j)
backend.md §9 propose `base = solde + exécutés + réservés`. Dans RAVZO les demandes réservées **restent dans le solde du coffre** jusqu'à exécution ; les rajouter compterait deux fois le même argent et laisserait passer une demande fractionnée (défaut révélé par le test T24). Convention retenue :
- `base = (épargne confirmée − versements confirmés depuis < 72 h) + retraits exceptionnels exécutés sur 30 j`
- `capacité = max(0, floor(20 % × base) − exécutés − réservés)` (arrondi plancher, conservateur)
- verrou `FOR UPDATE` par coffre à la demande et à la confirmation ; réévaluation à l'échéance → rejet si la base a baissé.
L'exclusion des versements < 72 h empêche le « dépôt puis retrait » gonflant la base. Tests : T23, T24.
