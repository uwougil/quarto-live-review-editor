# Changelog

[日本語](#日本語) | English

All notable changes to this extension are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Editable tables.** A table now stays rendered while you work in it, in the
  style of Obsidian's table editor. Clicking a cell makes that one cell
  editable in place and shows its raw Markdown, so `**bold**` survives a
  round-trip; `Tab`/`Shift+Tab` move between cells, `Enter` commits and `Esc`
  discards. Only the edited cell's own span is written back, leaving the rest
  of the row's text, padding and pipes byte-identical, so an edit cannot
  reflow the source or break the table's structure. Column widths are pinned
  for the duration of an edit, so swapping a cell's rendered text for its
  longer source no longer makes the whole table lurch sideways.
- **A `</>` code-mode button on every rendered block** — tables, Mermaid
  diagrams, frontmatter, and fenced code blocks — for reaching the Markdown
  behind it. Cell editing cannot change a table's *structure* (adding a row,
  editing the alignment row, repairing a broken table), so there has to be a
  deliberate way back to the source; giving every block the same control puts
  it in the same place whatever the block is. On a code block, whose text is
  already visible, it reveals the ` ``` ` fence lines and puts the caret on
  the language tag.
- **A `⧉` copy button on fenced code blocks.** Selecting a code block by hand
  sweeps up the hidden ` ``` ` fence lines and any indentation the block is
  nested under; the button copies the block's contents exactly.

### Changed

- **Clicking a Mermaid diagram now pans it instead of switching to its
  source.** Any click whose movement fell under the drag threshold used to be
  read as "show me the source", so a diagram would turn into raw text
  mid-gesture, exactly when it was being panned or zoomed. The `</>` button is
  the way to the source now, and the two can no longer be confused.
- **Table cell text can be selected and copied.** Dragging across cells
  highlights their text as ordinary text; previously the press was cancelled
  outright, so the rendered cells could not be selected at all.

### Fixed

- **A rendered block flipping to its raw source on a stray click.** Clicking
  near a table — its outer edge, the shared line between two rows, the strip
  above it — or simply clicking repeatedly could revert it to pipe text, often
  several times in a row. Three separate causes: the caret was being dragged
  *through* a block on the way somewhere else and that counted as entering it;
  the browser's own word-selection on the second click of a rapid pair looked
  like a drag-select and made the handler bail out; and the block's own bounds
  were tested rather than its surrounding box, leaving unguarded bands (30px
  above a table, 7px below) that belonged to no block at all.
- **A Mermaid diagram's reset (`↺`) not returning to the size it started at.**
  It reset the zoom but stayed in full-size mode, whose 1× is the diagram's
  natural width — so from a zoomed-in view the diagram shrank part-way and
  stopped, still larger than the fitted view it began from. It now goes all
  the way back.
- **Table cells rendering differently from every other Markdown renderer once
  their content got the least bit involved.** A cell's content is drawn outside
  CodeMirror, so it was rendered by a handful of hand-written regexes rather
  than by the parser. Anything past one flat construct came out wrong:
  `***bold italic***` kept stray asterisks, `**a *b* c**` and `**2 * 3**`
  collapsed into nonsense, `_underscore_` emphasis and images were not
  recognised at all, a lone `*` used as a multiplication sign turned into
  spurious italics, multi-backtick code spans broke apart, links with a title
  stayed raw text, and a link nested in bold never became a link. Cells now go
  through the same parser the rest of the document uses, so they follow GFM
  exactly. Backslash escapes, `<`/`&`, autolinks and `<br>` are handled too;
  any other raw HTML in a cell is shown literally rather than injected.
- **Column alignment (`|:--|:-:|--:|`) was ignored.** Every column rendered
  left-aligned.
- **Rows with too few or too many cells rendered ragged.** GFM fixes a table's
  column count at its delimiter row: short rows are now padded with empty cells
  and any overflow is dropped, so the table stays rectangular.

## [0.0.10] — 2026-08-27

### Fixed

- **Cursor landing on the wrong line, and jumpy scrolling.** Rendered tables,
  Mermaid diagrams, and frontmatter blocks carried their spacing as a CSS
  `margin`, which sits outside the box CodeMirror measures. Each one quietly
  dropped 14px from the editor's internal height map, and the error accumulated
  down the document — a click near the top of a file landed one line off, and
  further down, three. Documents with many tables or diagrams were worst
  affected. The spacing now lives inside the measured box, so positions match
  the rendering exactly, at any scroll position.
- **Layout lurching when a Mermaid diagram finished rendering.** Diagrams render
  asynchronously, and the editor was never told the block had grown from a
  one-line placeholder to its full height. The same applies to images as they
  load, and to the diagram fit/native toggle.
- **The caret jumping a line away after pressing Enter at the end of a
  paragraph**, then snapping back as soon as you typed. A paragraph now includes
  the blank line that follows it, so its trailing gap sits below that separator
  instead of above it. Rendering is unchanged.

### Added

- Claude Code's read-only output tabs can now be opened in the live preview via
  **Reopen Editor With…**. These are in-memory documents with no file extension,
  so the `*.md` association could never match them.

## [0.0.9] — 2026-07-28

### Fixed

- Tables placed directly under a list item with no blank line between them were
  left as raw text instead of being rendered.

## [0.0.6] – [0.0.8] — 2026-07-23

### Changed

- Marketplace screenshots recropped to show only the editor itself.

## [0.0.5] — 2026-07-23

### Added

- **Bold / italic keyboard shortcuts** (`Ctrl+B` / `Ctrl+I`).
- **Paste and drag-and-drop images.** Dropped files are saved under an `assets/`
  folder beside the document and linked with a plain relative path.
- **Outline view** in the sidebar, listing the document's headings.

### Fixed

- Pasting an image while the cursor sat inside a table corrupted the table.

## [0.0.4] — 2026-07-16

### Changed

- Marketplace listing adjustments.

## [0.0.3] — 2026-07-13

### Added

- **Mermaid fit / native display toggle**, with drag-to-pan and Ctrl+wheel zoom
  in native mode.
- Markdown editing conveniences: auto-pairing for emphasis marks and code
  fences, and automatic spacing after a heading marker.

### Fixed

- Frontmatter in a document stopped every other decoration in the file from
  rendering.
- Doubled vertical spacing on list items and blockquotes.
- Markdown files opened by another extension (an AI chat panel's file link, for
  instance) stayed in the plain text editor instead of switching to the live
  preview.

### Changed

- New installs now start with the VS Code-standard sample theme applied.

## [0.0.2] — 2026-07-09

### Fixed

- CSS theme loading, live-preview auto-reopen, and Mermaid rendering.

## [0.0.1] — 2026-07-08

- Initial Marketplace release.

---

## 日本語

この拡張機能の主な変更点をまとめています。
バージョン番号は [セマンティック バージョニング](https://semver.org/lang/ja/) に従っています。

## [Unreleased]

### 追加

- **テーブルをその場で編集できるようになりました。** Obsidian のテーブル
  エディタと同じように、表は描画されたままで作業できます。セルをクリックすると
  そのセルだけが編集状態になり、生の Markdown が表示されるので `**太字**` の
  ような装飾も保ったまま直せます。`Tab`/`Shift+Tab` でセル間を移動、`Enter` で
  確定、`Esc` で取り消しです。書き戻すのは編集したセルの範囲だけなので、行の
  ほかの文字・空白・`|` は一切変わりません。編集が表の形を崩すことはありません。
  編集中は列幅を固定するので、短い表示から長いソースに変わっても表全体が
  横に大きく動くことはありません。
- **描画されたブロックすべてに `</>`（コードモード）ボタンを追加しました。**
  テーブル・Mermaid・フロントマター・コードブロックが対象です。セル編集では
  行の追加や区切り行の変更といった「構造」は変えられないため、元の Markdown に
  戻る明確な入口が必要でした。どのブロックでも同じ位置に同じボタンがあります。
  コードブロックは元から文字が見えているので、このボタンでは隠れている
  ` ``` ` の囲み行を表示し、言語名のところにカーソルを置きます。
- **コードブロックに `⧉`（コピー）ボタンを追加しました。** 手で範囲選択すると
  隠れている ` ``` ` の囲み行や、入れ子のときの字下げまで一緒に入ってしまいます。
  このボタンは中身だけを正確にコピーします。

### 変更

- **Mermaid の図をクリックしても、ソース表示に切り替わらなくなりました。**
  これまでは、ドラッグと判定されない程度の小さな動きはすべて「ソースを見たい」
  と解釈していたため、図を動かそう・拡大しようとした最中に生テキストへ化けて
  いました。ソースを見るのは `</>` ボタンの役割にしたので、移動の操作と
  取り違えることがなくなりました。
- **表のセルの文字を選択してコピーできるようになりました。** セルをなぞると
  普通の文字と同じように選択できます。これまではマウスを押した時点で標準の
  動作を打ち消していたため、そもそも選択できませんでした。

### 修正

- **ちょっとしたクリックで、描画されたブロックが生のソースに戻ってしまう問題。**
  テーブルの外周、行と行の間の線、すぐ上の余白などを触ったときや、単に連打した
  ときに、生の `|` 記法へ戻ってしまい、しかも何度も続けて起きることがありました。
  原因は3つありました。ほかの場所へ向かう途中でカーソルがブロックを通過した
  だけなのに「入った」と判定していたこと。素早い2回クリックでブラウザが単語を
  自動選択し、それがドラッグ選択に見えて処理が中断していたこと。そして判定に
  ブロック自身の枠だけを使っていたため、その周り（表の上30px・下7px）に
  どのブロックにも属さない帯が残っていたことです。
- **Mermaid の図で、リセット（`↺`）を押しても最初の大きさに戻らない問題。**
  倍率は 1 に戻していましたが、原寸大モードのままでした。原寸大の1倍は図の
  本来の幅なので、拡大した状態から押すと途中の大きさで止まり、最初の縮小表示
  よりも大きいままでした。最後まで戻るようにしました。
- **表のセルの中身が少し複雑になると、他の Markdown ビューアと表示が変わる問題。**
  セルの中身は CodeMirror の外側で描画するため、パーサではなく手書きの正規表現で
  描いていました。そのため装飾が1つだけの単純な場合を超えると崩れていました。
  `***太字斜体***` はアスタリスクが残り、`**a *b* c**` や `**2 * 3**` は表示が
  壊れ、`_アンダースコア_` の強調と画像はそもそも認識されず、掛け算の意味で
  書いた `*` が斜体になり、バッククォート2個以上のコードは分断され、タイトル
  付きリンクは生のまま、太字の中のリンクはリンクになりませんでした。セルの中身も
  文書本体と同じパーサに通すようにしたので、GFM の規則どおりに表示されます。
  バックスラッシュのエスケープ、`<` や `&`、自動リンク、`<br>` にも対応しました。
  それ以外の生の HTML は、埋め込まずに文字としてそのまま表示します。
- **列揃え（`|:--|:-:|--:|`）が効いていなかった問題。** すべての列が左揃えで
  表示されていました。
- **セルの数が足りない行・多すぎる行で、表がガタついていた問題。** GFM では
  区切り行が列数を決めます。足りない行は空のセルで補い、多すぎる分は捨てるように
  したので、表の形が揃います。

## [0.0.10] — 2026-08-27

### 修正

- **カーソルが違う行に着地する問題と、スクロールのぐらつき。** 表・Mermaid 図・
  フロントマターの余白が CSS の `margin` で指定されていました。`margin` は
  CodeMirror が高さを測る範囲の外側にあるため、ブロック1個につき 14px が
  内部の高さ計算から抜け落ちていました。しかもこのズレは文書の下に行くほど
  積み上がります。ファイル冒頭では1行、下の方では3行ずれていました。表や図が
  多い文書ほど影響が大きい状態でした。余白を測定範囲の内側に移したので、
  どのスクロール位置でも表示と位置が一致します。
- **Mermaid 図の描画が終わった瞬間に画面が跳ねる問題。** 図は非同期で描画され
  ますが、1行分のプレースホルダーから実際の高さに変わったことをエディタに
  伝えていませんでした。画像の読み込み完了時、図の表示モード切替時も同様です。
- **段落の末尾で Enter を押すとカーソルが1行分離れた場所に飛び**、入力を始めると
  戻ってくる問題。段落が直後の空行を含むようにしたので、余白が区切り行の上では
  なく下に来ます。見た目は変わりません。

### 追加

- Claude Code の読み取り専用の出力タブを、**「エディターを選択して再度開く」**
  からライブプレビューで開けるようになりました。これらは拡張子を持たない
  メモリ上の仮想ファイルなので、`*.md` の関連付けでは対象にできませんでした。

## [0.0.9] — 2026-07-28

### 修正

- 箇条書きの直下に空行なしで置いた表が、描画されず生のテキストのままだった問題。

## [0.0.6] – [0.0.8] — 2026-07-23

### 変更

- Marketplace 用のスクリーンショットを、エディタ部分だけが写るよう切り直し。

## [0.0.5] — 2026-07-23

### 追加

- **太字・斜体のキーボードショートカット**（`Ctrl+B` / `Ctrl+I`）。
- **画像の貼り付けとドラッグ＆ドロップ。** 文書の隣の `assets/` フォルダに保存し、
  相対パスで挿入します。
- サイドバーの **アウトライン表示**（見出し一覧）。

### 修正

- カーソルが表の中にある状態で画像を貼ると、表が壊れる問題。

## [0.0.4] — 2026-07-16

### 変更

- Marketplace の掲載内容の調整。

## [0.0.3] — 2026-07-13

### 追加

- **Mermaid の「自動縮小 / 原寸大」表示切り替え。** 原寸大表示ではドラッグで移動、
  Ctrl+ホイールで拡大縮小ができます。
- 編集の補助機能: 強調記号とコードフェンスの自動対応付け、見出し記号の後の
  自動スペース。

### 修正

- フロントマターがあると、文書内の他の装飾がすべて描画されなくなる問題。
- 箇条書きと引用の縦の余白が二重になる問題。
- 他の拡張機能（AI チャットのファイルリンクなど）から開いた Markdown が、
  ライブプレビューに切り替わらず通常のテキストエディタのままだった問題。

### 変更

- 新規インストール時に、VS Code 標準のサンプルテーマが適用されるようになりました。

## [0.0.2] — 2026-07-09

### 修正

- CSS テーマの読み込み、ライブプレビューの自動再オープン、Mermaid の描画。

## [0.0.1] — 2026-07-08

- Marketplace への初回公開。
