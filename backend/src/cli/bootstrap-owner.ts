import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createInterface } from 'readline';
import { AppModule } from '../app.module';
import { IdentityService } from '../modules/identity/identity.service';

/** Création unique du propriétaire. Usage : npm run owner:bootstrap -- <email> "<Nom>"  (mot de passe saisi ou RAVZO_OWNER_PASSWORD). */
async function main() {
  const [email, name] = process.argv.slice(2);
  if (!email) { console.error('Usage: owner:bootstrap <email> "<Nom affiché>"'); process.exit(1); }
  const password = process.env.RAVZO_OWNER_PASSWORD ?? await new Promise<string>((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Mot de passe (12 caractères min.) : ', (a) => { rl.close(); res(a); });
  });
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const r = await app.get(IdentityService).bootstrapOwner(email, password, name ?? 'Propriétaire');
  console.log('\nPropriétaire créé. Conservez ces informations HORS LIGNE — elles ne seront plus affichées.\n');
  console.log(`Code d’initialisation du premier appareil (7 jours) : ${r.bootstrapCode}`);
  console.log('Codes de secours (usage unique) :');
  r.recoveryCodes.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c}`));
  await app.close();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
