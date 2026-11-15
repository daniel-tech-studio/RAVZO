import { redactAmounts } from '../../src/modules/platform/fcm-push.service';
describe('push : montants masqués', () => {
  it('masque montants et devises, garde le texte', () => {
    expect(redactAmounts('Paiement de 10 150 FCFA à Awa')).toBe('Paiement de ••• à Awa');
    expect(redactAmounts('SNTS ≥ 25000 FCFA')).toBe('SNTS ≥ •••');
    expect(redactAmounts('Budget Alimentation à 85 %')).toBe('Budget Alimentation à 85 %');
    expect(redactAmounts('Retrait 500 F effectué')).toBe('Retrait ••• effectué');
  });
});
