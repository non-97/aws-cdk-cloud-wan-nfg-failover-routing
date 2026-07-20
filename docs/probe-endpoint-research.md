# ヘルスチェック疎通先の調査記録 (2026-07-15 起票 / 2026-07-19 更新)

ヘルスチェックの疎通先を「AWS 管理のエンドポイント優先」へ変更した際の調査と実測の記録である。
動機は、疎通確認のために 1.1.1.1 / 8.8.8.8 (サードパーティの公開 DNS) へ毎サイクル接続するのを避けることである。
サードパーティのサービスを常時監視の宛先に使い続けるのは望ましくないという判断による。監視系の判定がサードパーティのサービスの可用性と利用規約に依存することを避けるためである。

## 採用した構成 (tier 化 + NS の実行時解決)

tier 1 から順に試行し、tier 内は並列、前の tier の全エンドポイントへの接続に失敗したときだけ次へ進む。

| tier | 宛先 | 種別 |
| --- | --- | --- |
| 1 | amazonaws.com の NS レコードを実行時に解決した権威ネームサーバー全台 (TCP/53) | - Route 53 権威 DNS <br>- AWS 管理 / anycast / IP は固定 (static) と公式に明記されている |
| 1 | checkip.amazonaws.com:443 | AWS CLI ガイドのコマンド例に登場するエンドポイント |
| 2 | 1.1.1.1:53 / 8.8.8.8:53 | サードパーティの最終フォールバック <br>平常時は接続しない <br>IP 直指定で DNS 非依存 |

権威 DNS サーバーの名前も IP も config に固定値として埋め込まない。
Lambda が実行のたびに amazonaws.com の NS レコードを引き、返ってきたサーバー群へ展開する (NS の入れ替えに自動で追従する)。
Python 標準ライブラリに NS 問い合わせの手段がないため、NS クエリ 1 種に限定した最小 DNS クライアントを Lambda に同梱した。dnspython は同梱しなかった。同梱すると、インラインコード 1 ファイルで完結する現行のデプロイ構成にバンドル手順の追加が必要になるためである。
lookup の失敗はその場で記録され、残りのエンドポイントが判定を担う。全エンドポイントへの接続に失敗した場合は unhealthy と判定する。判定に迷う場合は検査できない通信を通さない方向 (fail-close 方向) に倒す設計であり、誤検知による不要な切り替えのリスクは確認再測定 (README のヘルスチェック仕様) で緩和する。
名前解決は VPC 内リゾルバーで完結し検査経路を通らないが、判定に使う TCP 接続が経路を通るため目的を満たす。
tier 2 だけは IP 直指定のままにし、万一 VPC の名前解決に問題があっても最終フォールバックは DNS 非依存で判定できる構造にしている。

## 調査した候補と結論

| 候補 | 結論 | 理由 |
| --- | --- | --- |
| Route 53 権威 DNS サーバー | 採用 (tier 1) | AWS 管理 / anycast / IP static が公式記載 <br>TCP/53 で現行実装と同一ポート |
| checkip.amazonaws.com | 採用 (tier 1) | AWS CLI ガイドのコマンド例に登場するエンドポイント <br>TCP/443 |
| checkip.global.api.aws | 未評価 (2026-07-19 追記) | CLI ガイドの Note が公式に案内する別エンドポイント <br>tier 1 への採用は接続実測後に判断 |
| Amazon 版のパブリック再帰 DNS | 不採用 | 誰でも利用できる公開再帰 DNS は存在しない <br>VPC 内リゾルバーはインターネット経由到達不可 <br>Route 53 Global Resolver は認証済みクライアント限定 |
| Amazon Time Sync (time.aws.com) | 不採用 | NTP は UDP/123 で TCP 接続チェックに使えない <br>NTS (TCP/4460) 対応の公式記述は確認できず |
| S3 等リージョナルエンドポイント | 不採用 | TCP/443 で使えるが、リージョン障害と経路障害の切り分けに別リージョン選定が必要で、checkip で足りる |
| CloudFront エッジ | 不採用 | checkip と特性が重複 (TCP/443 / DNS 解決 / IP 可変) |
| Global Accelerator 静的 IP | 不採用 | 自前リソースであり AWS 管理の公開エンドポイントではない |

## 実測と事前確認 (2026-07-15)

- 公式ドキュメントに明記がないため、amazonaws.com の権威 NS 2 台 (ns-1321.awsdns-37.org / ns-1670.awsdns-16.co.uk) への TCP/53 ハンドシェイクを `nc -z` で実測し、手元環境から 2 台への受理を確認した (全サーバー / 全経路での受理を保証するものではない)
- 検査経路上の Network Firewall は pass-all 構成 (inspection-vpc.ts) で、宛先追加にルール変更は不要
- ヘルスチェック Lambda のセキュリティグループにアウトバウンド制限は設けていない

## VPC Lambda からのリゾルバー到達性の実測 (2026-07-16)

VPC Lambda の resolv.conf が別のリンクローカルフォワーダーを指すという実測記事があり、169.254.169.253 が Lambda サンドボックスから使えるか疑問が生じた。そこで検証用に一時作成した VPC Lambda で本番と同じ NS クエリ実装を 4 経路に対して実行した。VPC は us-west-2 の default VPC、ランタイムは python3.13 である。

| 経路 | 結果 |
| --- | --- |
| /etc/resolv.conf の実値 (169.254.100.5) | 成功 |
| 169.254.169.253 (本番コードの送信先) | **成功** |
| 169.254.78.1 (過去記事のフォワーダー) | 失敗 (PermissionError) |
| VPC+2 (172.31.0.2) | 成功 |

- 結論: 本番コードの送信先である 169.254.169.253 への NS クエリは、**python3.13 / us-west-2 の default VPC の条件で動作することを確認した** (取得 NS は dig と完全一致)。本番構成 (Python 3.14 / 本番の HealthCheck VPC) での確認はデプロイ後の実機検証に含める (README の実機検証の項目 21)
- Lambda の resolv.conf はサンドボックス内のリンクローカルフォワーダーを指し、DHCP オプションセットに追従する (参考記事の実測どおり)。ただしそのアドレスは実装詳細であり、変更され得る (記事時点 169.254.78.1 → 実測時 169.254.100.5)。文書化された安定アドレスの 169.254.169.253 を使う現設計を維持する
- 参考記事: [dev.classmethod.jp の実測記事](https://dev.classmethod.jp/articles/vpc-lambda-dhcp-option-sets/)

## 制約と注意

- 死活監視の宛先としての利用可否について、AWS の公式見解はいずれの候補にも記載がない。NS lookup の送信先は VPC リゾルバーであって監視宛先ではない。監視宛先へは TCP ハンドシェイクのみを送り、クエリ / リクエストは送らない。頻度は 6 関数 x 3 分間隔 x 各エンドポイント 3 試行であり軽微である
- NS lookup は VPC リゾルバー経由の再帰問い合わせであり、権威サーバーへの直接クエリではない (直接送るのは TCP ハンドシェイクのみ)
- NS lookup の送信先はリンクローカルの 169.254.169.253 である。VPC ユーザーガイドに明記があり、VPC Lambda からの到達も 2026-07-16 に実測確認済み (上のセクション)。VPC の enableDnsSupport が有効であることが前提 (CDK のデフォルトで有効)
- checkip.amazonaws.com と NS 名の解決は VPC の名前解決に依存する。解決失敗は接続失敗として扱われ、tier 2 (IP 直指定) が判定を担う
- 検査経路上の Network Firewall を制限的なルールにする場合は、上記の疎通先すべての許可をルール変更のたびに回帰確認する (許可漏れはヘルスチェックの誤検知となり不要なフェイルオーバーを誘発する)

## 追記 (2026-07-19): checkip.amazonaws.com の位置づけの正確化

出典ページの本文を再取得して確認した事実を記録する。実装 (config / Lambda) の変更は行わない。

- checkip.amazonaws.com は AWS CLI ガイドの curl のコマンド例に登場するだけであり、「公式ドキュメント記載の管理エンドポイント」という従来の記述は正確でなかった
- 同ページの Note は別エンドポイントの [checkip.global.api.aws](https://checkip.global.api.aws/) を公式に案内している (原文: "We provide the following service, https://checkip.global.api.aws/")
- 従来の出典は AWS CLI v1 のガイドであり、v1 は end-of-support が告知されている。AWS CLI v2 ガイドの相当ページに同じ Note とコマンド例があることを 2026-07-19 に確認したため、出典は v2 ガイドへ差し替えた
- checkip.global.api.aws の tier 1 への採用は接続実測後に判断する

## 出典

- Route 53 の IP レンジと static の明記: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/route-53-ip-addresses.html
- Route 53 の DNS over TCP (UDP 切り詰め時の TCP フォールバック): https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSBehavior.html
- Route 53 の anycast 構成: https://aws.amazon.com/route53/faqs/
- Route 53 Global Resolver が認証済みクライアント限定であること: https://aws.amazon.com/route53/global-resolver/
- checkip.amazonaws.com のコマンド例と checkip.global.api.aws の Note による案内 (AWS CLI v2 ガイド): https://docs.aws.amazon.com/cli/latest/userguide/cli-services-ec2-sg.html
- VPC 内リゾルバーがインターネット到達不可であること: https://docs.aws.amazon.com/vpc/latest/userguide/AmazonDNS-concepts.html
- Amazon Time Sync のプロトコル: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configure-time-sync.html
- ip-ranges.json: https://docs.aws.amazon.com/general/latest/gr/aws-ip-ranges.html
