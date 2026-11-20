// Turns the words read off a picture back into a document: rows from where the words sit (not the OCR engine's own
// lines, which often split a table row into one "line" per cell), tables where rows share column gaps, and headings,
// lists and paragraphs everywhere else. Then writes that out as plain text, Markdown, HTML or CSV.

use crate::ocr::Word;

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Heading(u8, String),
    Para(String),
    List(bool, Vec<String>),
    Table(Vec<Vec<String>>),
}

#[derive(Debug, Clone)]
struct Row { words: Vec<Word>, top: f32, bottom: f32, left: f32, right: f32, h: f32 }

impl Row {
    fn text(&self) -> String { self.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ") }
    fn cy(&self) -> f32 { (self.top + self.bottom) / 2.0 }
}

fn median(mut v: Vec<f32>) -> f32 {
    if v.is_empty() { return 0.0; }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// Words that sit side by side (their middles within half a word's height) make one row, left to right.
fn rows(words: &[Word]) -> Vec<Row> {
    let mut ws: Vec<Word> = words.iter().filter(|w| !w.text.trim().is_empty()).cloned().collect();
    ws.sort_by(|a, b| (a.y + a.height / 2.0).partial_cmp(&(b.y + b.height / 2.0)).unwrap());
    let mut out: Vec<Row> = Vec::new();
    for w in ws {
        let cy = w.y + w.height / 2.0;
        let hit = out.iter_mut().rev().take(3).find(|r| (cy - r.cy()).abs() < 0.5 * w.height.max(r.h));
        match hit {
            Some(r) => { r.top = r.top.min(w.y); r.bottom = r.bottom.max(w.y + w.height); r.left = r.left.min(w.x); r.right = r.right.max(w.x + w.width); r.h = r.h.max(w.height); r.words.push(w); }
            None => out.push(Row { top: w.y, bottom: w.y + w.height, left: w.x, right: w.x + w.width, h: w.height, words: vec![w] }),
        }
    }
    for r in &mut out { r.words.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap()); r.h = median(r.words.iter().map(|w| w.height).collect()); }
    out.sort_by(|a, b| a.top.partial_cmp(&b.top).unwrap());
    out
}

/// Where the row breaks into cells: gaps between words wider than about one and a half letters' height.
fn cells(r: &Row, h0: f32) -> Vec<(f32, f32, String)> {
    let mut out: Vec<(f32, f32, String)> = Vec::new();
    for w in &r.words {
        match out.last_mut() {
            Some(c) if w.x - c.1 < 1.3 * h0 => { c.1 = c.1.max(w.x + w.width); c.2.push(' '); c.2 += &w.text; }
            _ => out.push((w.x, w.x + w.width, w.text.clone())),
        }
    }
    out
}

/// Columns of a run of rows: the x ranges where any of them has a cell, merged where they overlap.
fn columns(rows: &[Row], h0: f32) -> Vec<(f32, f32)> {
    let mut spans: Vec<(f32, f32)> = rows.iter().flat_map(|r| cells(r, h0).into_iter().map(|c| (c.0, c.1))).collect();
    spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut cols: Vec<(f32, f32)> = Vec::new();
    for s in spans {
        match cols.last_mut() { Some(c) if s.0 < c.1 + 0.6 * h0 => c.1 = c.1.max(s.1), _ => cols.push(s) }
    }
    cols
}

fn table(rows: &[Row], h0: f32) -> Option<Vec<Vec<String>>> {
    if rows.len() < 2 { return None; }
    let cols = columns(rows, h0);
    if cols.len() < 2 { return None; }
    let grid: Vec<Vec<String>> = rows.iter().map(|r| {
        let mut line = vec![String::new(); cols.len()];
        for c in cells(r, h0) {
            let mid = (c.0 + c.1) / 2.0;
            let i = cols.iter().position(|k| mid >= k.0 && mid <= k.1).unwrap_or(0);
            if !line[i].is_empty() { line[i].push(' '); }
            line[i] += &c.2;
        }
        line
    }).collect();
    // A table if most rows fill at least two columns (a two-column page of prose is the price of this guess).
    let full = grid.iter().filter(|l| l.iter().filter(|c| !c.is_empty()).count() >= 2).count();
    (full * 3 >= grid.len() * 2 && (rows.len() >= 3 || cols.len() >= 3)).then_some(grid)
}

fn bullet(t: &str) -> Option<(bool, String)> {
    let t = t.trim_start();
    for b in ["• ", "· ", "- ", "– ", "* ", "▪ ", "○ ", "◦ ", "■ ", "● "] { if let Some(r) = t.strip_prefix(b) { return Some((false, r.trim().to_string())); } }
    let n = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if n > 0 && n < 4 { let rest = &t[n..]; if let Some(r) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) { return Some((true, r.trim().to_string())); } }
    None
}

/// Joins a wrapped line onto the one before, mending words split with a hyphen at the end of a line.
fn join(a: &mut String, b: &str) {
    if a.ends_with('-') && b.chars().next().is_some_and(|c| c.is_lowercase()) { a.pop(); } else { a.push(' '); }
    *a += b;
}

pub fn blocks(words: &[Word]) -> Vec<Block> {
    let rs = rows(words);
    if rs.is_empty() { return vec![]; }
    let h0 = median(rs.iter().map(|r| r.h).collect()).max(1.0);
    let right = rs.iter().map(|r| r.right).fold(0.0, f32::max);
    let mut out: Vec<Block> = Vec::new();
    let mut i = 0;
    while i < rs.len() {
        // A run of rows that break into cells, close together, is a table candidate.
        let mut j = i;
        while j < rs.len() && cells(&rs[j], h0).len() >= 2 && (j == i || rs[j].top - rs[j - 1].bottom < 3.5 * h0) { j += 1; }
        if j > i { if let Some(t) = table(&rs[i..j], h0) { out.push(Block::Table(t)); i = j; continue; } }
        let r = &rs[i];
        let text = r.text();
        // Rows with wide gaps in them (a label and its value, say) are never headings or wrapped prose.
        let one = |r: &Row| cells(r, h0).len() == 1;
        if r.h > 1.45 * h0 && one(r) && text.split_whitespace().count() <= 14 {
            out.push(Block::Heading(if r.h > 1.8 * h0 { 1 } else { 2 }, text));
        } else if let Some((ordered, item)) = bullet(&text) {
            match out.last_mut() {
                Some(Block::List(o, items)) if *o == ordered && r.top - rs[i - 1].bottom < 1.2 * h0 => items.push(item),
                _ => out.push(Block::List(ordered, vec![item])),
            }
        } else {
            // Carry on the paragraph only when the line before ran to (nearly) the full width, i.e. it wrapped.
            let prev = i.checked_sub(1).map(|k| &rs[k]);
            let wrapped = prev.is_some_and(|p| one(p) && one(r) && r.top - p.bottom < 0.8 * h0 && (r.left - p.left).abs() < 1.5 * h0 && (r.h - p.h).abs() < 0.25 * h0 && p.right - p.left > 12.0 * h0 && p.right > p.left + 0.8 * (right - p.left));
            match out.last_mut() {
                Some(Block::Para(t)) if wrapped => join(t, &text),
                Some(Block::List(_, items)) if wrapped || prev.is_some_and(|p| r.top - p.bottom < 0.5 * h0 && r.left > p.left + 0.8 * h0) => join(items.last_mut().unwrap(), &text),
                _ => out.push(Block::Para(text)),
            }
        }
        i += 1;
    }
    out
}

// ---- writers ----

fn esc(t: &str) -> String { t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;") }
fn md_cell(t: &str) -> String { t.replace('|', "\\|") }
fn csv_cell(t: &str) -> String { if t.contains([',', '"', '\n']) { format!("\"{}\"", t.replace('"', "\"\"")) } else { t.to_string() } }

/// Plain text: paragraphs unwrapped, tables as tab-separated rows (they paste into a spreadsheet as cells).
pub fn plain(b: &[Block]) -> String {
    b.iter().map(|x| match x {
        Block::Heading(_, t) | Block::Para(t) => t.clone(),
        Block::List(o, items) => items.iter().enumerate().map(|(i, t)| if *o { format!("{}. {t}", i + 1) } else { format!("• {t}") }).collect::<Vec<_>>().join("\n"),
        Block::Table(rows) => rows.iter().map(|r| r.join("\t")).collect::<Vec<_>>().join("\n"),
    }).collect::<Vec<_>>().join("\n\n")
}

pub fn markdown(b: &[Block]) -> String {
    b.iter().map(|x| match x {
        Block::Heading(l, t) => format!("{} {t}", "#".repeat(*l as usize)),
        Block::Para(t) => t.clone(),
        Block::List(o, items) => items.iter().enumerate().map(|(i, t)| if *o { format!("{}. {t}", i + 1) } else { format!("- {t}") }).collect::<Vec<_>>().join("\n"),
        Block::Table(rows) => {
            let n = rows[0].len();
            let line = |r: &Vec<String>| format!("| {} |", r.iter().map(|c| md_cell(c)).collect::<Vec<_>>().join(" | "));
            let mut out = vec![line(&rows[0]), format!("|{}", " --- |".repeat(n))];
            out.extend(rows[1..].iter().map(line));
            out.join("\n")
        }
    }).collect::<Vec<_>>().join("\n\n")
}

pub fn html(b: &[Block]) -> String {
    b.iter().map(|x| match x {
        Block::Heading(l, t) => format!("<h{l}>{}</h{l}>", esc(t)),
        Block::Para(t) => format!("<p>{}</p>", esc(t)),
        Block::List(o, items) => { let tag = if *o { "ol" } else { "ul" }; format!("<{tag}>{}</{tag}>", items.iter().map(|t| format!("<li>{}</li>", esc(t))).collect::<String>()) }
        Block::Table(rows) => format!("<table><thead><tr>{}</tr></thead><tbody>{}</tbody></table>",
            rows[0].iter().map(|c| format!("<th>{}</th>", esc(c))).collect::<String>(),
            rows[1..].iter().map(|r| format!("<tr>{}</tr>", r.iter().map(|c| format!("<td>{}</td>", esc(c))).collect::<String>())).collect::<String>()),
    }).collect::<Vec<_>>().join("\n")
}

/// CSV of the tables; with none, every line split where its words leave a wide gap.
pub fn csv(words: &[Word], b: &[Block]) -> String {
    let tables: Vec<&Vec<Vec<String>>> = b.iter().filter_map(|x| if let Block::Table(t) = x { Some(t) } else { None }).collect();
    let rows: Vec<Vec<String>> = if tables.is_empty() {
        let rs = rows(words);
        let h0 = median(rs.iter().map(|r| r.h).collect()).max(1.0);
        rs.iter().map(|r| cells(r, h0).into_iter().map(|c| c.2).collect()).collect()
    } else {
        tables.iter().enumerate().flat_map(|(i, t)| { let mut v: Vec<Vec<String>> = if i > 0 { vec![vec![]] } else { vec![] }; v.extend(t.iter().cloned()); v }).collect()
    };
    rows.iter().map(|r| r.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(",")).collect::<Vec<_>>().join("\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Words laid out like text on screen: each (x, y, text) with letters 8 px wide and `h` high.
    fn ws(h: f32, items: &[(f32, f32, &str)]) -> Vec<Word> {
        items.iter().enumerate().map(|(i, &(x, y, t))| Word { text: t.into(), x, y, width: t.chars().count() as f32 * h * 0.5, height: h, line: i }).collect()
    }

    #[test]
    fn table_from_rows_with_column_gaps() {
        let mut items = vec![(0.0, 0.0, "Order"), (200.0, 0.0, "Customer"), (400.0, 0.0, "Total")];
        for (i, (o, c, t)) in [("#1045", "Sam", "$37.00"), ("#1044", "Mia", "$26.50"), ("#1043", "Rata", "$184.00")].iter().enumerate() {
            let y = 24.0 * (i as f32 + 1.0);
            items.extend([(0.0, y, *o), (200.0, y, *c), (400.0 - (t.len() as f32 - 5.0) * 8.0, y, *t)]);
        }
        let b = blocks(&ws(16.0, &items));
        assert_eq!(b, vec![Block::Table(vec![
            vec!["Order".into(), "Customer".into(), "Total".into()],
            vec!["#1045".into(), "Sam".into(), "$37.00".into()],
            vec!["#1044".into(), "Mia".into(), "$26.50".into()],
            vec!["#1043".into(), "Rata".into(), "$184.00".into()],
        ])]);
        assert!(markdown(&b).starts_with("| Order | Customer | Total |\n| --- | --- | --- |\n| #1045 | Sam | $37.00 |"));
        assert!(plain(&b).starts_with("Order\tCustomer\tTotal\n#1045\tSam\t$37.00"));
        assert!(html(&b).contains("<th>Customer</th>") && html(&b).contains("<td>$184.00</td>"));
        assert!(csv(&[], &b).starts_with("Order,Customer,Total\r\n#1045,Sam,$37.00\r\n"));
    }

    #[test]
    fn engine_lines_per_cell_still_make_one_row() {
        // Same row, three separate OCR "lines" (as Windows reports table cells), slightly different heights.
        let mut w = ws(16.0, &[(0.0, 0.0, "A"), (200.0, 1.0, "B"), (400.0, 0.0, "C"), (0.0, 24.0, "1"), (200.0, 24.0, "2"), (400.0, 25.0, "3"), (0.0, 48.0, "4"), (200.0, 48.0, "5"), (400.0, 48.0, "6")]);
        w[1].height = 15.0;
        assert!(matches!(&blocks(&w)[..], [Block::Table(t)] if t.len() == 3 && t[0] == ["A", "B", "C"]));
    }

    #[test]
    fn heading_wrapped_paragraph_and_list() {
        let mut w = ws(30.0, &[(0.0, 0.0, "Release"), (120.0, 0.0, "notes")]);
        let body = ws(16.0, &[
            (0.0, 50.0, "This"), (40.0, 50.0, "version"), (110.0, 50.0, "makes"), (160.0, 50.0, "copying"), (230.0, 50.0, "text"), (270.0, 50.0, "much"), (310.0, 50.0, "bet-"),
            (0.0, 70.0, "ter"), (30.0, 70.0, "for"), (60.0, 70.0, "everyone."),
            (0.0, 100.0, "•"), (12.0, 100.0, "Tables"),
            (0.0, 120.0, "•"), (12.0, 120.0, "Markdown"),
        ]);
        w.extend(body);
        let b = blocks(&w);
        assert_eq!(b, vec![
            Block::Heading(1, "Release notes".into()),
            Block::Para("This version makes copying text much better for everyone.".into()),
            Block::List(false, vec!["Tables".into(), "Markdown".into()]),
        ]);
        assert_eq!(markdown(&b), "# Release notes\n\nThis version makes copying text much better for everyone.\n\n- Tables\n- Markdown");
    }

    #[test]
    fn short_ui_labels_stay_on_their_own_lines() {
        let w = ws(16.0, &[(0.0, 0.0, "Revenue"), (70.0, 0.0, "today"), (0.0, 20.0, "$3,178.40"), (0.0, 40.0, "Orders"), (0.0, 60.0, "128")]);
        assert_eq!(plain(&blocks(&w)), "Revenue today\n\n$3,178.40\n\nOrders\n\n128");
    }

    #[test]
    fn csv_quotes_and_markdown_escapes() {
        let b = vec![Block::Table(vec![vec!["a,b".into(), "x|y".into()], vec!["say \"hi\"".into(), "2".into()]])];
        assert_eq!(csv(&[], &b), "\"a,b\",x|y\r\n\"say \"\"hi\"\"\",2");
        assert!(markdown(&b).contains("x\\|y"));
    }
}

