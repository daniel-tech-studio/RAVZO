import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { config } from '../common/config';

export interface OutgoingNotification { id: string; type: string; priority: string; title: string; body: string; link: string | null }
export type ChannelResult = { status: 'SENT' | 'NOT_CONFIGURED' | 'FAILED'; error?: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * E-mail (B31) via SMTP authentifié, expéditeur « RAVZO » ; corps sobre, sans secret ni identifiant interne.
 * Idempotence : en-tête Message-ID dérivé de la clé de livraison (le worker ne renvoie pas une livraison SENT).
 */
export class EmailChannel {
  private log = new Logger('Email');
  private transport = config.smtp.host ? nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: { user: config.smtp.user, pass: config.smtp.password }, connectionTimeout: 15_000 }) : null;
  get configured() { return !!this.transport && !!config.smtp.fromAddress; }
  async verify() { if (!this.transport) return false; await this.transport.verify(); return true; }
  async send(to: string, n: OutgoingNotification, idempotencyKey: string): Promise<ChannelResult> {
    if (!this.configured) return { status: 'NOT_CONFIGURED', error: 'SMTP non configuré' };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || /\.(local|test|invalid|example)$/i.test(to)) return { status: 'NOT_CONFIGURED', error: 'Adresse du propriétaire non routable' };
    const prio = n.priority === 'CRITICAL' ? '[Important] ' : '';
    const html = `<!doctype html><html><body style="margin:0;background:#F6F7F2;font-family:Inter,Arial,sans-serif;color:#1D2B2A">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:18px;border:1px solid #D9E3DF">
<tr><td style="background:#176356;border-radius:18px 18px 0 0;padding:20px 24px;color:#fff;font-size:20px;font-weight:700;letter-spacing:1.5px">RAVZO</td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 10px;font-size:19px">${esc(n.title)}</h1><p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:#3E4F4C">${esc(n.body)}</p>
<p style="margin:0;font-size:13px;color:#52625F">Ouvrez l’application RAVZO pour voir le détail. Ce message ne demande jamais de mot de passe ni de code et ne déclenche aucun paiement.</p></td></tr>
</table></td></tr></table></body></html>`;
    try {
      await this.transport!.sendMail({
        from: { name: config.smtp.fromName, address: config.smtp.fromAddress }, to, subject: `${prio}${n.title}`,
        text: `${n.title}\n\n${n.body}\n\nOuvrez l’application RAVZO pour voir le détail. Ce message ne demande jamais de mot de passe ni de code et ne déclenche aucun paiement.`,
        html, messageId: `<${idempotencyKey.replace(/[^A-Za-z0-9.-]/g, '-')}@ravzo.app>`, headers: { 'X-RAVZO-Notification': n.type },
      });
      return { status: 'SENT' };
    } catch (e: any) {
      this.log.warn(JSON.stringify({ email: 'failed', code: e?.code, responseCode: e?.responseCode }));
      return { status: 'FAILED', error: String(e?.code ?? e?.message).slice(0, 200) };
    }
  }
}
