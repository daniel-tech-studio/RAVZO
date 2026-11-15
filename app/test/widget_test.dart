import 'package:flutter_test/flutter_test.dart';
import 'package:ravzo/core/format.dart';

void main() {
  test('format XOF', () {
    expect(money('150000'), '150\u202F000\u00A0FCFA');
    expect(money('-4500'), '−4\u202F500\u00A0FCFA');
    expect(money('150000', hidden: true), '•••••• FCFA');
    expect(parseAmountInput('150 000'), '150000');
    expect(parseAmountInput('12,5'), isNull);
    expect(parseAmountInput('0'), isNull);
  });
}
