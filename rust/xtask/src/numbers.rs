//! A test that fails when `serde_json` is built without `float_roundtrip`.
//!
//! Without the feature `serde_json` reads some decimals one unit in the last place away from the correctly rounded
//! double, which is what `JSON.parse` and `str::parse::<f64>` give, so a Rust loader would disagree with the
//! TypeScript runner exactly at the boundaries the corpus pins.

#[cfg(test)]
mod tests {
    /// Decimals whose correctly rounded double is not what `serde_json`'s fast path gives without the feature.
    const LITERALS: [&str; 9] = [
        "2.2250738585072011e-308",
        "1.2345678901234567e22",
        "7.2057594037927933e16",
        "8.5070591730234616e37",
        "6.0221409e23",
        "1.00000000000000011102230246251565404236316680908203125",
        "0.1000000000000000055511151231257827021181583404541015626",
        "9007199254740993",
        "5e-324",
    ];

    #[test]
    fn a_decimal_reads_as_the_correctly_rounded_double() {
        for literal in LITERALS {
            let read: f64 = serde_json::from_str(literal).expect("a number");
            let expected: f64 = literal.parse().expect("a number");
            assert_eq!(read.to_bits(), expected.to_bits(), "{literal}");
        }
    }
}
