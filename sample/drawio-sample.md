# draw.io サンプル

## 1. コードフェンスで書く

XML をそのまま ` ```drawio ` の中に書くと、その場で図になります。

```drawio
<mxfile>
  <diagram name="システム構成">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="web" value="Web サーバー" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="160" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="api" value="API サーバー" style="rounded=1;fillColor=#d5e8d4;strokeColor=#82b366" vertex="1" parent="1">
          <mxGeometry x="280" y="40" width="160" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="db" value="データベース" style="shape=cylinder;fillColor=#ffe6cc;strokeColor=#d79b00" vertex="1" parent="1">
          <mxGeometry x="300" y="180" width="120" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="e1" value="HTTP" style="" edge="1" parent="1" source="web" target="api">
          <mxGeometry as="geometry"/>
        </mxCell>
        <mxCell id="e2" value="SQL" style="" edge="1" parent="1" source="api" target="db">
          <mxGeometry as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

## 2. 基本の図形

```drawio
<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="a" value="四角" vertex="1" parent="1">
      <mxGeometry x="20" y="20" width="100" height="50" as="geometry"/>
    </mxCell>
    <mxCell id="b" value="楕円" style="ellipse" vertex="1" parent="1">
      <mxGeometry x="150" y="20" width="100" height="50" as="geometry"/>
    </mxCell>
    <mxCell id="c" value="判断" style="rhombus" vertex="1" parent="1">
      <mxGeometry x="280" y="10" width="100" height="70" as="geometry"/>
    </mxCell>
    <mxCell id="d" value="六角形" style="shape=hexagon" vertex="1" parent="1">
      <mxGeometry x="20" y="110" width="100" height="50" as="geometry"/>
    </mxCell>
    <mxCell id="e" value="メモ" style="shape=note" vertex="1" parent="1">
      <mxGeometry x="150" y="110" width="100" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="f" value="処理" style="shape=process" vertex="1" parent="1">
      <mxGeometry x="280" y="110" width="100" height="50" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>
```

## 3. 外部ファイルを参照する

draw.io アプリで作った `.drawio` ファイルは、画像と同じ書き方で読み込めます。

![構成図](./assets/architecture.drawio)

`.drawio.svg` や `.drawio.png` で保存したものは、これまで通り普通の画像として表示されます。
