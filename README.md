# DailyDataset

每日汇总 arXiv 与 Preprints.org 的数据集相关预印本，通过[静态网站](https://lartpang.github.io/DailyDataset/)按年、月、日浏览论文及其摘要。网站按需加载单日数据。

标题包含 `dataset`、`data set`、`benchmark` 或 `corpus` 等关键词的论文会被纳入；关键词匹配可能误收或漏收。Preprints.org 元数据来自 Crossref，日期均为 UTC。

## 本地运行

项目只依赖 Python 标准库，无需安装依赖：

```bash
python3 -m http.server 8000  # 访问 http://localhost:8000/
python3 daily_dataset.py     # 采集并更新数据
```

首次采集回溯近五年，后续从上次成功日期向前重叠 14 天更新；Crossref 增量采集包含新登记和更新过的元数据。已有完整归档时，可运行 `python3 daily_dataset.py --render-only` 仅重新生成网站数据，或使用 `--start YYYY-MM-DD --end YYYY-MM-DD` 补采指定日期范围。

## 自动更新与发布

GitHub Actions 每天 UTC 06:17 采集并更新数据，也可手动运行。推送仓库后，在 **Settings → Pages → Build and deployment** 中将 Source 设为 **GitHub Actions**，即可通过部署工作流发布网站。采集工作流需要仓库写入权限。
