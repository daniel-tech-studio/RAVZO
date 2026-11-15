import nodemailer from 'nodemailer';
import { config } from '../../src/common/config';
import { EmailChannel } from '../../src/worker/channels';

describe('Canal e-mail', () => {
  it('expéditeur RAVZO, sujet préfixé si critique, aucun secret, Message-ID idempotent', async () => {
    Object.assign(config.smtp, { host: 'smtp.example.org', fromAddress: 'contact@souven.example', fromName: 'RAVZO' });
    const ch = new EmailChannel();
    (ch as any).transport = nodemailer.createTransport({ jsonTransport: true });
    const sent: any[] = [];
    const orig = (ch as any).transport.sendMail.bind((ch as any).transport);
    (ch as any).transport.sendMail = async (m: any) => { const r = await orig(m); sent.push(JSON.parse(r.message)); return r; };
    const r = await ch.send('moi@exemple.bj', { id: 'n1', type: 'security.device_approved', priority: 'CRITICAL', title: 'Nouvel appareil <approuvé>', body: 'Un appareil a été ajouté.', link: '/security' }, 'abc:EMAIL');
    expect(r.status).toBe('SENT');
    expect(sent[0].from).toEqual({ address: 'contact@souven.example', name: 'RAVZO' });
    expect(sent[0].subject).toBe('[Important] Nouvel appareil <approuvé>');
    expect(sent[0].html).toContain('&lt;approuvé&gt;');
    expect(sent[0].messageId).toBe('<abc-EMAIL@ravzo.app>');
    expect(JSON.stringify(sent[0])).not.toMatch(/password|SMTP_|mot de passe:/i);
    expect((await ch.send('dev@ravzo.local', { id: 'n2', type: 't', priority: 'LOW', title: 't', body: 'b', link: null }, 'k')).status).toBe('NOT_CONFIGURED');
  });
});
