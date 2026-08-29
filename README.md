# HyperKart

ブラウザで走るカートレーサー。12台、3周、4コース。

**素材ファイルを持たない。** 地形もテクスチャもモデルも音も、すべて実行時にコードから生成される。
依存は `three` 一つだけ。

```bash
npm install
npm run dev        # http://localhost:5178
```

開いたら操作カードが出る。読み終えて **START RACE** を押すとレースが始まる。

### 配る / サーバ無しで動かす

```bash
npm run build:single     # → dist/hyperkart.html
```

**1ファイル 1.13 MB、外部リクエスト 0。ダブルクリックで開く。**

> `index.html` を直接開いても動かない。`<script type="module">` は `file://` から読めない（ブラウザの CORS 規則で、null オリジンのページは自分の隣のファイルすら取得できない）。
> `npm run build` の `dist/` は**任意の静的サーバ**で動くが、ダブルクリックでは開けない。
> `build:single` はバンドルを IIFE で作ってクラシックスクリプトとして HTML に畳み込むので、その制約から外れる。

---

## これは何か

- Three.js 一枚、実装 23,533 行（30 モジュール）
- **画像も音声もリポジトリに無い** — `ProcTex` がテクスチャを描き、`KartModel` と `SceneryKit` がジオメトリを組み、`AudioEngine` が Web Audio で音を合成する
- 固定 120Hz の決定論的シミュレーション。同じ種からは同じレースが出る
- 4コース：**Sunset Coast**（海沿い）、**Canyon Rush**（峡谷）、**Frostline Basin**（氷の路面。**路面グリップが低い唯一のコース**）、**Rainbow Skyway**（壁の無い虹路）
- コースは**データで定義される**。地形の形、プロップの一覧、看板の色、空、路面の物理は全部テーマのフィールドで、`TRACKS` に足せば周回選択にも次コースにも出る
- 12キャラクターが軽・中・重の三クラスに分かれ、**クラスごとに車体が違う**
- アイテム 11 種、三段のドリフトチャージ、ゲームパッド対応

---

## 文書

| | |
|---|---|
| [`docs/MANUAL.md`](docs/MANUAL.md) | 操作手順書。キー、ドリフト、アイテム、コース、URL パラメータ |
| [`docs/TECHNICAL.md`](docs/TECHNICAL.md) | 技術設計書と**開発回顧録** |

---

## 検証ツール

このプロジェクトの特徴は、**見えないものを測る道具を持っていること**にある。生成物は目で見るまで存在が確認できず、ブラウザは平気で嘘をつく。

```bash
node tools/shot.mjs --series 0,12,20,52 --track sunsetCoast --outdir shots/
node tools/analyze.mjs --track frostlineBasin   # コーナー半径と、AI が導く速度プロファイル
node tools/sim.mjs   --track canyonRush --field 12 --seeds 3
node tools/audioaudit.mjs        # OfflineAudioContext で音を描画して測る
node tools/fxaudit.mjs           # エフェクトの実面積と自車の遮蔽率
node tools/renderaudit.mjs --deep  # draw call を払って何も描いていない物体
```

`shot.mjs` のキャプチャは**バイト単位で再現する**。再現しないものは改善なのか偶然なのか判定できないので、これが全ての土台になっている。

---

## 開発について

55 コミットのうち多くは新機能ではなく、**見えていなかったものを見えるようにする**作業だった。

- コードとして完全にもっともらしく、一切機能していなかったものが **12 個**見つかった（リムの内側に封印されたホイールスポーク、読み出しの無い uniform、何も隠さない `--hide`、…）
- **13個目は音響システム全体**だった。docblock は8種類の音を宣言していたが、音を出す二つのメソッドは空で、205 行のユーティリティはどこからも import されていなかった。静止画のルーブリックには音の評価軸が無く、5ラウンドの批評で誰も気づかなかった
- すべてのキャプチャが **133ms 遅れていた**時期があり、55ms の衝突エフェクトは構造的にどのフレームにも写り得なかった
- 5ラウンドの批評すべてが、カメラを **2.7〜3.5° 起こした**フレームから下されていた

詳細は [`docs/TECHNICAL.md`](docs/TECHNICAL.md) の第7章。

---

## ライセンス

private
