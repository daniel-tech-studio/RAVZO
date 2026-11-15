import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/format.dart';
import 'motion.dart';
import 'theme.dart';
import 'tokens.dart';

class ChartPoint { final String label; final double value; final bool forecast; final String? raw; const ChartPoint(this.label, this.value, {this.forecast = false, this.raw}); }
class ChartSeries { final String name; final List<ChartPoint> points; final Color color; final bool fill; const ChartSeries(this.name, this.points, this.color, {this.fill = true}); }

/// Courbe/aire animée : révélation progressive, transitions entre périodes, info-bulle au survol (desktop) et au toucher (mobile).
/// Les points prévisionnels sont tracés en pointillés (llm §14.3 : ne jamais mélanger réel et prévision).
class AreaChart extends StatefulWidget {
  final List<ChartSeries> series;
  final double height;
  final void Function(int index)? onSelect;
  const AreaChart({super.key, required this.series, this.height = 200, this.onSelect});
  @override
  State<AreaChart> createState() => _AreaChartState();
}
class _AreaChartState extends State<AreaChart> with SingleTickerProviderStateMixin {
  late final AnimationController c = AnimationController(vsync: this, duration: Motion.hero)..forward();
  int? hover;
  @override
  void didUpdateWidget(AreaChart old) { super.didUpdateWidget(old); if (old.series.length != widget.series.length || (old.series.isNotEmpty && widget.series.isNotEmpty && old.series.first.points.length != widget.series.first.points.length)) c.forward(from: 0); }
  @override
  void dispose() { c.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final hidden = context.app.hideAmounts;
    if (Motion.reduced(context)) c.value = 1;
    final n = widget.series.isEmpty ? 0 : widget.series.map((s) => s.points.length).reduce(math.max);
    return LayoutBuilder(builder: (ctx, cons) {
      void pick(Offset o) { if (n < 2) return; final i = ((o.dx / cons.maxWidth) * (n - 1)).round().clamp(0, n - 1); if (i != hover) setState(() => hover = i); }
      return MouseRegion(onHover: (e) => pick(e.localPosition), onExit: (_) => setState(() => hover = null), child: GestureDetector(
        onPanDown: (d) => pick(d.localPosition), onPanUpdate: (d) => pick(d.localPosition), onPanEnd: (_) => setState(() => hover = null),
        onTapUp: (d) { pick(d.localPosition); if (hover != null) widget.onSelect?.call(hover!); },
        child: AnimatedBuilder(animation: c, builder: (_, _) => SizedBox(height: widget.height, width: cons.maxWidth, child: CustomPaint(painter: _AreaPainter(widget.series, Curves.easeOutCubic.transform(c.value), hover, p, hidden)))),
      ));
    });
  }
}
class _AreaPainter extends CustomPainter {
  final List<ChartSeries> series; final double t; final int? hover; final Palette p; final bool hidden;
  _AreaPainter(this.series, this.t, this.hover, this.p, this.hidden);
  @override
  void paint(Canvas canvas, Size size) {
    if (series.isEmpty || series.every((s) => s.points.isEmpty)) return;
    final all = series.expand((s) => s.points.map((e) => e.value));
    var maxV = all.reduce(math.max), minV = math.min(0.0, all.reduce(math.min));
    if (maxV == minV) maxV = minV + 1;
    const top = 22.0, bottom = 22.0;
    final h = size.height - top - bottom;
    double y(double v) => top + h - ((v - minV) / (maxV - minV)) * h;
    final grid = Paint()..color = p.border.withValues(alpha: .6)..strokeWidth = 1;
    for (var i = 0; i <= 3; i++) { final gy = top + h * i / 3; canvas.drawLine(Offset(0, gy), Offset(size.width, gy), grid); }
    if (minV < 0) canvas.drawLine(Offset(0, y(0)), Offset(size.width, y(0)), Paint()..color = p.inkMuted.withValues(alpha: .5)..strokeWidth = 1.2);
    for (final s in series) {
      final pts = s.points;
      if (pts.length < 2) continue;
      final dx = size.width / (pts.length - 1);
      final reveal = (pts.length - 1) * t;
      Path path = Path(), fcPath = Path();
      var fcStarted = false;
      for (var i = 0; i < pts.length && i <= reveal.ceil(); i++) {
        final frac = i <= reveal ? 1.0 : reveal - (i - 1);
        final prev = i == 0 ? pts[0] : pts[i - 1];
        final x = dx * (i - 1 + frac).clamp(0, pts.length - 1).toDouble();
        final v = i == 0 ? pts[0].value : prev.value + (pts[i].value - prev.value) * frac;
        final o = Offset(i == 0 ? 0 : x, y(v));
        if (pts[i].forecast) { if (!fcStarted) { fcPath.moveTo(dx * (i - 1).clamp(0, 1 << 30), y(prev.value)); fcStarted = true; } fcPath.lineTo(o.dx, o.dy); }
        else if (i == 0) { path.moveTo(o.dx, o.dy); } else { path.lineTo(o.dx, o.dy); }
      }
      if (s.fill) {
        final b = path.getBounds();
        final fill = Path.from(path)..lineTo(b.right, top + h)..lineTo(0, top + h)..close();
        canvas.drawPath(fill, Paint()..shader = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [s.color.withValues(alpha: .28), s.color.withValues(alpha: 0)]).createShader(Rect.fromLTWH(0, top, size.width, h)));
      }
      canvas.drawPath(path, Paint()..color = s.color..strokeWidth = 2.6..style = PaintingStyle.stroke..strokeCap = StrokeCap.round..strokeJoin = StrokeJoin.round);
      for (final m in fcPath.computeMetrics()) { for (double d = 0; d < m.length; d += 9) { canvas.drawPath(m.extractPath(d, math.min(d + 5, m.length)), Paint()..color = s.color.withValues(alpha: .7)..strokeWidth = 2.2..style = PaintingStyle.stroke); } }
    }
    final first = series.first.points;
    if (hover != null && hover! < first.length && first.length > 1) {
      final dx = size.width / (first.length - 1);
      final x = dx * hover!;
      canvas.drawLine(Offset(x, top - 6), Offset(x, top + h), Paint()..color = p.inkMuted.withValues(alpha: .5)..strokeWidth = 1);
      final lines = <String>[first[hover!].label];
      for (final s in series) { if (hover! < s.points.length) { final pt = s.points[hover!]; canvas.drawCircle(Offset(x, y(pt.value)), 5, Paint()..color = s.color); canvas.drawCircle(Offset(x, y(pt.value)), 2.4, Paint()..color = p.surface); lines.add('${s.name} : ${hidden ? '•••' : money(pt.raw ?? pt.value.round().toString(), compact: true)}${pt.forecast ? ' (prévision)' : ''}'); } }
      final tp = TextPainter(text: TextSpan(text: lines.join('\n'), style: inter(11.5, color: p.background, w: FontWeight.w600, height: 1.35)), textDirection: TextDirection.ltr)..layout(maxWidth: 220);
      final bx = (x + 12 + tp.width + 16 > size.width) ? x - tp.width - 28 : x + 12;
      canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(bx, 0, tp.width + 16, tp.height + 12), const Radius.circular(10)), Paint()..color = p.ink.withValues(alpha: .92));
      tp.paint(canvas, Offset(bx + 8, 6));
    }
    final lp = TextPainter(text: TextSpan(text: first.first.label, style: inter(10.5, color: p.inkMuted)), textDirection: TextDirection.ltr)..layout();
    lp.paint(canvas, Offset(0, size.height - 15));
    final rp = TextPainter(text: TextSpan(text: first.last.label, style: inter(10.5, color: p.inkMuted)), textDirection: TextDirection.ltr)..layout();
    rp.paint(canvas, Offset(size.width - rp.width, size.height - 15));
  }
  @override
  bool shouldRepaint(_AreaPainter o) => o.t != t || o.hover != hover || o.series != series || o.hidden != hidden;
}

class DonutSlice { final String label; final double value; final Color color; final String? raw; const DonutSlice(this.label, this.value, this.color, {this.raw}); }

/// Anneau animé avec sélection au toucher/survol.
class Donut extends StatefulWidget {
  final List<DonutSlice> slices;
  final double size;
  final Widget? center;
  const Donut({super.key, required this.slices, this.size = 170, this.center});
  @override
  State<Donut> createState() => _DonutState();
}
class _DonutState extends State<Donut> {
  int? sel;
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final total = widget.slices.fold<double>(0, (s, e) => s + e.value.abs());
    return AnimatedProgress(value: 1, builder: (_, t) => SizedBox(width: widget.size, height: widget.size, child: Stack(alignment: Alignment.center, children: [
      GestureDetector(onTapUp: (d) => _hit(d.localPosition, total), child: MouseRegion(onHover: (e) => _hit(e.localPosition, total), onExit: (_) => setState(() => sel = null), child: CustomPaint(size: Size.square(widget.size), painter: _DonutPainter(widget.slices, total, t, sel, p)))),
      IgnorePointer(child: sel != null && sel! < widget.slices.length
        ? Column(mainAxisSize: MainAxisSize.min, children: [Text(widget.slices[sel!].label, style: inter(12, color: p.inkMuted), textAlign: TextAlign.center), Text(total == 0 ? '0 %' : '${(widget.slices[sel!].value.abs() / total * 100).round()} %', style: sora(20, color: p.ink))])
        : (widget.center ?? const SizedBox())),
    ])));
  }
  void _hit(Offset o, double total) {
    final c = Offset(widget.size / 2, widget.size / 2);
    final d = o - c;
    if (d.distance < widget.size * .28 || d.distance > widget.size / 2 || total == 0) { if (sel != null) setState(() => sel = null); return; }
    var a = math.atan2(d.dy, d.dx) + math.pi / 2;
    if (a < 0) a += 2 * math.pi;
    var acc = 0.0;
    for (var i = 0; i < widget.slices.length; i++) { acc += widget.slices[i].value.abs() / total * 2 * math.pi; if (a <= acc) { if (sel != i) setState(() => sel = i); return; } }
  }
}
class _DonutPainter extends CustomPainter {
  final List<DonutSlice> s; final double total, t; final int? sel; final Palette p;
  _DonutPainter(this.s, this.total, this.t, this.sel, this.p);
  @override
  void paint(Canvas canvas, Size size) {
    final r = size.width / 2, rect = Rect.fromCircle(center: Offset(r, r), radius: r * .8);
    canvas.drawArc(rect, 0, 2 * math.pi, false, Paint()..color = p.surfaceAlt..style = PaintingStyle.stroke..strokeWidth = r * .3);
    if (total == 0) return;
    var start = -math.pi / 2;
    for (var i = 0; i < s.length; i++) {
      final sweep = s[i].value.abs() / total * 2 * math.pi * t;
      final w = r * (sel == i ? .36 : .28);
      canvas.drawArc(rect, start + .02, math.max(0, sweep - .04), false, Paint()..color = s[i].color..style = PaintingStyle.stroke..strokeWidth = w..strokeCap = StrokeCap.butt);
      start += sweep;
    }
  }
  @override
  bool shouldRepaint(_DonutPainter o) => o.t != t || o.sel != sel || o.s != s;
}

/// Anneau de progression d'objectif (coffres) avec rotation d'entrée.
class Ring extends StatelessWidget {
  final double value;
  final double size, stroke;
  final Color? color;
  final Widget? child;
  const Ring({super.key, required this.value, this.size = 64, this.stroke = 7, this.color, this.child});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return AnimatedProgress(value: value.clamp(0, 1).toDouble(), builder: (_, v) => SizedBox(width: size, height: size, child: Stack(alignment: Alignment.center, children: [
      CustomPaint(size: Size.square(size), painter: _RingPainter(v, color ?? p.primary, p.surfaceAlt, stroke)), ?child,
    ])));
  }
}
class _RingPainter extends CustomPainter {
  final double v; final Color c, bg; final double w;
  _RingPainter(this.v, this.c, this.bg, this.w);
  @override
  void paint(Canvas canvas, Size size) {
    final rect = Rect.fromLTWH(w / 2, w / 2, size.width - w, size.height - w);
    canvas.drawArc(rect, 0, math.pi * 2, false, Paint()..color = bg..style = PaintingStyle.stroke..strokeWidth = w);
    canvas.drawArc(rect, -math.pi / 2, math.pi * 2 * v, false, Paint()..shader = SweepGradient(colors: [c.withValues(alpha: .55), c], transform: const GradientRotation(-math.pi / 2)).createShader(rect)..style = PaintingStyle.stroke..strokeWidth = w..strokeCap = StrokeCap.round);
  }
  @override
  bool shouldRepaint(_RingPainter o) => o.v != v || o.c != c;
}

/// Barres « prévu vs réel » horizontales animées.
class CompareBar extends StatelessWidget {
  final String label;
  final String plannedMinor, actualMinor;
  final String status;
  final String? forecastMinor;
  const CompareBar({super.key, required this.label, required this.plannedMinor, required this.actualMinor, required this.status, this.forecastMinor});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final r = ratio(actualMinor, plannedMinor);
    final f = forecastMinor == null ? 0.0 : ratio(forecastMinor, plannedMinor);
    final color = status == 'EXCEEDED' ? p.error : status == 'WARNING' ? p.warning : p.primary;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [Expanded(child: Text(label, style: inter(14, w: FontWeight.w600, color: p.ink))), Text('${(r * 100).round()} %', style: inter(13, w: FontWeight.w700, color: color, tab: true))]),
      const SizedBox(height: 6),
      AnimatedProgress(value: 1, builder: (_, t) => SizedBox(height: 10, child: LayoutBuilder(builder: (_, c) => Stack(children: [
        Container(decoration: BoxDecoration(color: p.surfaceAlt, borderRadius: BorderRadius.circular(6))),
        if (f > r) Container(width: c.maxWidth * math.min(f, 1) * t, decoration: BoxDecoration(color: color.withValues(alpha: .18), borderRadius: BorderRadius.circular(6))),
        Container(width: c.maxWidth * math.min(r, 1) * t, decoration: BoxDecoration(gradient: LinearGradient(colors: [color.withValues(alpha: .7), color]), borderRadius: BorderRadius.circular(6))),
      ])))),
    ]);
  }
}
