import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/app_state.dart';
import '../../core/format.dart';
import '../../design/components.dart';
import '../../design/motion.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(body: Center(child: AnimatedProgress(value: 1, builder: (_, v) => Opacity(opacity: v, child: Transform.scale(scale: .9 + .1 * v, child: Image.asset('assets/brand/monogram.png', width: 120))))));
}

class _AuthFrame extends StatelessWidget {
  final List<Widget> children;
  const _AuthFrame({required this.children});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final form = Center(child: SingleChildScrollView(padding: const EdgeInsets.all(28), child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 420), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [for (var i = 0; i < children.length; i++) Enter(index: i, child: children[i])]))));
    if (!wide) return Scaffold(body: SafeArea(child: form));
    return Scaffold(body: Row(children: [
      Expanded(child: Container(decoration: BoxDecoration(gradient: p.heroGradient), child: Stack(children: [
        Positioned(right: -120, bottom: -120, child: Container(width: 460, height: 460, decoration: BoxDecoration(shape: BoxShape.circle, gradient: RadialGradient(colors: [p.accent.withValues(alpha: .35), Colors.transparent])))),
        Padding(padding: const EdgeInsets.all(56), child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
          ClipRRect(borderRadius: BorderRadius.circular(22), child: Image.asset('assets/brand/monogram.png', width: 96)),
          const SizedBox(height: 32),
          Text('La puissance d’un outil financier complet,', style: sora(34, w: FontWeight.w700, color: Colors.white, height: 1.15)),
          Text('sans compromis sur la vérité des chiffres.', style: sora(34, w: FontWeight.w300, color: const Color(0xFFA1E6CC), height: 1.15)),
          const SizedBox(height: 20),
          Text('Privé · mono-utilisateur · XOF · registre en double entrée', style: inter(15, color: Colors.white.withValues(alpha: .75))),
        ])),
      ]))),
      Expanded(child: form),
    ]));
  }
}

class WelcomeScreen extends StatefulWidget {
  const WelcomeScreen({super.key});
  @override
  State<WelcomeScreen> createState() => _WelcomeScreenState();
}
class _WelcomeScreenState extends State<WelcomeScreen> {
  int page = 0;
  static const slides = [
    (Icons.insights_rounded, 'Tout votre argent, clairement', 'Comptes, budgets par cycle de revenu, coffres, dettes, patrimoine et BRVM — chaque chiffre porte sa provenance : confirmé, suivi, estimé ou prévisionnel.'),
    (Icons.savings_rounded, 'Une discipline qui vous ressemble', 'Coffres à objectifs, versements suggérés jamais automatiques, délai de 72 h et plafond de 20 % pour les retraits exceptionnels.'),
    (Icons.verified_user_rounded, 'Sécurité sans compromis', 'Appareils de confiance à clé, validation forte à chaque opération sensible, plafonds 30 000 / 60 000 FCFA et journal d’audit.'),
  ];
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final s = slides[page];
    return _AuthFrame(children: [
      Center(child: Image.asset('assets/brand/logo-full.png', height: 64)),
      const SizedBox(height: 36),
      SwapValue(valueKey: page, child: Column(children: [
        Container(width: 84, height: 84, decoration: BoxDecoration(shape: BoxShape.circle, color: p.accentSoft), child: Icon(s.$1, size: 40, color: p.primary)),
        const SizedBox(height: 20),
        Text(s.$2, textAlign: TextAlign.center, style: sora(24, color: p.ink)),
        const SizedBox(height: 10),
        Text(s.$3, textAlign: TextAlign.center, style: inter(15, color: p.inkMuted, height: 1.5)),
      ])),
      const SizedBox(height: 22),
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [for (var i = 0; i < slides.length; i++) AnimatedContainer(duration: Motion.d(context, Motion.base), margin: const EdgeInsets.all(4), width: i == page ? 22 : 8, height: 8, decoration: BoxDecoration(color: i == page ? p.primary : p.border, borderRadius: BorderRadius.circular(8)))]),
      const SizedBox(height: 28),
      FilledButton(onPressed: () => page < slides.length - 1 ? setState(() => page++) : context.go('/login'), child: Text(page < slides.length - 1 ? 'Suivant' : 'Se connecter')),
      TextButton(onPressed: () => context.go('/login'), child: const Text('Passer')),
    ]);
  }
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}
class _LoginScreenState extends State<LoginScreen> {
  final email = TextEditingController(), password = TextEditingController(), device = TextEditingController(text: Platform.isMacOS ? 'Mac' : Platform.isIOS ? 'iPhone' : 'Android');
  final form = GlobalKey<FormState>();
  bool busy = false, obscure = true;
  String? error;
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return _AuthFrame(children: [
      Text('Connexion sécurisée', style: sora(28, w: FontWeight.w700, color: p.ink)),
      const SizedBox(height: 6),
      Text('Cet appareil sera identifié par une clé qui ne quitte jamais son stockage sécurisé.', style: inter(14.5, color: p.inkMuted, height: 1.4)),
      const SizedBox(height: 26),
      Form(key: form, child: AutofillGroup(child: Column(children: [
        TextFormField(controller: email, autofillHints: const [AutofillHints.email], keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'E-mail', prefixIcon: Icon(Icons.alternate_email_rounded)), validator: (v) => (v ?? '').contains('@') ? null : 'E-mail requis'),
        gap(14),
        TextFormField(controller: password, obscureText: obscure, autofillHints: const [AutofillHints.password], onFieldSubmitted: (_) => submit(), decoration: InputDecoration(labelText: 'Mot de passe', prefixIcon: const Icon(Icons.lock_outline_rounded), suffixIcon: IconButton(onPressed: () => setState(() => obscure = !obscure), icon: Icon(obscure ? Icons.visibility_rounded : Icons.visibility_off_rounded))), validator: (v) => (v ?? '').isEmpty ? 'Mot de passe requis' : null),
        gap(14),
        TextFormField(controller: device, decoration: const InputDecoration(labelText: 'Nom de cet appareil', prefixIcon: Icon(Icons.devices_rounded))),
      ]))),
      if (error != null) ...[gap(14), InfoBanner(error!, icon: Icons.error_outline_rounded, color: p.error)],
      gap(22),
      FilledButton(onPressed: busy ? null : submit, child: busy ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4)) : const Text('Se connecter')),
      gap(8),
      TextButton(onPressed: () => context.go('/recovery'), child: const Text('Accès perdu ? Récupération du compte')),
    ]);
  }
  Future<void> submit() async {
    if (!form.currentState!.validate()) return;
    setState(() { busy = true; error = null; });
    try { await context.appRead.login(email.text.trim(), password.text, device.text.trim().isEmpty ? 'Appareil' : device.text.trim()); }
    catch (e) { setState(() => error = errText(e)); }
    finally { if (mounted) setState(() => busy = false); }
  }
}

class EnrollScreen extends StatefulWidget {
  const EnrollScreen({super.key});
  @override
  State<EnrollScreen> createState() => _EnrollScreenState();
}
class _EnrollScreenState extends State<EnrollScreen> {
  final code = TextEditingController();
  Timer? poll;
  bool busy = false;
  String? error;
  @override
  void dispose() { poll?.cancel(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final app = context.app;
    final req = app.pendingEnrollment;
    return _AuthFrame(children: [
      Text('Approuver cet appareil', style: sora(28, w: FontWeight.w700, color: p.ink)),
      gap(8),
      Text('Un nouvel appareil doit être approuvé par un appareil de confiance — ou, pour le tout premier, par le code d’initialisation remis à la création du compte.', style: inter(14.5, color: p.inkMuted, height: 1.45)),
      gap(24),
      if (req != null) AppCard(gradient: p.heroGradient, child: Column(children: [
        Text('Code à saisir sur votre appareil de confiance', textAlign: TextAlign.center, style: inter(14, color: Colors.white70)),
        gap(10),
        SelectableText(req['code'].toString().replaceAllMapped(RegExp(r'.{4}'), (m) => '${m[0]} ').trim(), style: sora(36, w: FontWeight.w700, color: Colors.white, spacing: 4)),
        gap(8),
        Text('Expire ${fmtDateTime(req['expiresAt'])} · vérification automatique…', style: inter(12.5, color: Colors.white70)),
      ])) else OutlinedButton.icon(onPressed: busy ? null : () async { await run(context, () => app.requestEnrollment()); poll = Timer.periodic(const Duration(seconds: 4), (_) => app.refreshMe()); }, icon: const Icon(Icons.phonelink_lock_rounded), label: const Text('Demander l’approbation à un appareil de confiance')),
      gap(28),
      Text('Premier appareil', style: sora(17, color: p.ink)),
      gap(10),
      TextField(controller: code, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'Code d’initialisation', prefixIcon: Icon(Icons.key_rounded))),
      if (error != null) ...[gap(12), InfoBanner(error!, icon: Icons.error_outline_rounded, color: p.error)],
      gap(14),
      FilledButton(onPressed: busy ? null : () async { setState(() { busy = true; error = null; }); try { await app.bootstrapEnroll(code.text.trim()); } catch (e) { setState(() => error = errText(e)); } finally { if (mounted) setState(() => busy = false); } }, child: const Text('Activer cet appareil')),
      gap(8),
      TextButton(onPressed: () => app.signOut(), child: const Text('Se déconnecter')),
    ]);
  }
}

class RecoveryScreen extends StatefulWidget {
  const RecoveryScreen({super.key});
  @override
  State<RecoveryScreen> createState() => _RecoveryScreenState();
}
class _RecoveryScreenState extends State<RecoveryScreen> {
  final email = TextEditingController(), code = TextEditingController(), pwd = TextEditingController();
  Map? start;
  bool busy = false;
  String? error;
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final app = context.app;
    return _AuthFrame(children: [
      Text('Récupération du compte', style: sora(28, w: FontWeight.w700, color: p.ink)),
      gap(10),
      InfoBanner('Une récupération révoque toutes les sessions et appareils, puis suspend les modifications financières pendant 48 heures. La consultation et la révocation restent possibles.', icon: Icons.lock_clock_rounded, color: p.warning),
      gap(22),
      TextField(controller: email, enabled: start == null, decoration: const InputDecoration(labelText: 'E-mail du compte')),
      if (start != null) ...[
        gap(14), TextField(controller: code, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'Code de secours (usage unique)')),
        gap(14), TextField(controller: pwd, obscureText: true, decoration: const InputDecoration(labelText: 'Nouveau mot de passe (facultatif, 12 car. min.)')),
      ],
      if (error != null) ...[gap(12), InfoBanner(error!, icon: Icons.error_outline_rounded, color: p.error)],
      gap(20),
      FilledButton(onPressed: busy ? null : () async {
        setState(() { busy = true; error = null; });
        try {
          if (start == null) { start = await app.startRecovery(email.text.trim()); }
          else { await app.verifyRecovery(start!, code.text.trim(), pwd.text, Platform.localHostname); }
        } catch (e) { error = errText(e); }
        if (mounted) setState(() => busy = false);
      }, child: Text(start == null ? 'Continuer' : 'Récupérer le compte')),
      TextButton(onPressed: () => context.go('/login'), child: const Text('Retour à la connexion')),
    ]);
  }
}
