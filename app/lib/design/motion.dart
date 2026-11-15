import 'package:flutter/material.dart';

/// Système de mouvement expressif (llm.md §2.5) : chorégraphies, micro-interactions, et dégradation propre si « réduire les animations ».
class Motion {
  static const fast = Duration(milliseconds: 180), base = Duration(milliseconds: 320), slow = Duration(milliseconds: 620), hero = Duration(milliseconds: 900);
  static const emphasized = Cubic(0.2, 0.0, 0.0, 1.0), spring = Curves.easeOutBack, settle = Curves.easeOutCubic;
  static bool reduced(BuildContext c) => (MediaQuery.maybeDisableAnimationsOf(c) ?? false) || ReduceMotionScope.of(c);
  static Duration d(BuildContext c, Duration x) => reduced(c) ? Duration.zero : x;
}

class ReduceMotionScope extends InheritedWidget {
  final bool reduce;
  const ReduceMotionScope({super.key, required this.reduce, required super.child});
  static bool of(BuildContext c) => c.dependOnInheritedWidgetOfExactType<ReduceMotionScope>()?.reduce ?? false;
  @override
  bool updateShouldNotify(ReduceMotionScope o) => o.reduce != reduce;
}

/// Entrée chorégraphiée : fondu + glissement + légère mise à l'échelle, décalée par index.
class Enter extends StatefulWidget {
  final Widget child;
  final int index;
  final Offset from;
  const Enter({super.key, required this.child, this.index = 0, this.from = const Offset(0, 18)});
  @override
  State<Enter> createState() => _EnterState();
}
class _EnterState extends State<Enter> with SingleTickerProviderStateMixin {
  late final AnimationController c = AnimationController(vsync: this, duration: Motion.slow);
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (Motion.reduced(context)) { c.value = 1; return; }
    if (!c.isAnimating && c.value == 0) Future.delayed(Duration(milliseconds: 45 * widget.index.clamp(0, 12)), () { if (mounted) c.forward(); });
  }
  @override
  void dispose() { c.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    final a = CurvedAnimation(parent: c, curve: Motion.emphasized);
    return AnimatedBuilder(animation: a, builder: (_, child) => Opacity(opacity: a.value, child: Transform.translate(offset: widget.from * (1 - a.value), child: Transform.scale(scale: .985 + .015 * a.value, child: child))), child: widget.child);
  }
}

/// Micro-interaction de pression : compression élastique + halo au survol (desktop).
class Pressable extends StatefulWidget {
  final Widget child;
  final VoidCallback? onTap;
  final double radius;
  final String? semanticLabel;
  const Pressable({super.key, required this.child, this.onTap, this.radius = 18, this.semanticLabel});
  @override
  State<Pressable> createState() => _PressableState();
}
class _PressableState extends State<Pressable> {
  bool down = false, hover = false;
  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    return Semantics(button: enabled, label: widget.semanticLabel, child: MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : MouseCursor.defer,
      onEnter: (_) => setState(() => hover = true), onExit: (_) => setState(() => hover = false),
      child: GestureDetector(
        onTapDown: enabled ? (_) => setState(() => down = true) : null,
        onTapCancel: () => setState(() => down = false),
        onTapUp: (_) => setState(() => down = false),
        onTap: widget.onTap,
        child: AnimatedScale(scale: down ? .965 : (hover ? 1.012 : 1), duration: Motion.d(context, down ? Motion.fast : Motion.base), curve: down ? Curves.easeOut : Motion.spring, child: widget.child),
      ),
    ));
  }
}

/// Changement de valeur : fondu croisé + glissement vertical (jamais un compteur qui « défile » vers un montant non confirmé).
class SwapValue extends StatelessWidget {
  final Widget child;
  final Object valueKey;
  const SwapValue({super.key, required this.child, required this.valueKey});
  @override
  Widget build(BuildContext context) => AnimatedSwitcher(
    duration: Motion.d(context, Motion.base),
    transitionBuilder: (w, a) => FadeTransition(opacity: a, child: SlideTransition(position: Tween(begin: const Offset(0, .25), end: Offset.zero).animate(CurvedAnimation(parent: a, curve: Motion.emphasized)), child: w)),
    child: KeyedSubtree(key: ValueKey(valueKey), child: child),
  );
}

/// Valeur progressive animée 0 → v (progressions d'objectif, jauges).
class AnimatedProgress extends StatelessWidget {
  final double value;
  final Widget Function(BuildContext, double) builder;
  const AnimatedProgress({super.key, required this.value, required this.builder});
  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(tween: Tween(begin: 0, end: value), duration: Motion.d(context, Motion.hero), curve: Motion.emphasized, builder: (c, v, _) => builder(c, v));
}
