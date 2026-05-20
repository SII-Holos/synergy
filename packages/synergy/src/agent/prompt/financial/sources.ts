export interface FinancialSource {
  id: string
  name: string
  url: string
  description: string
  bestFor: string[]
}

export const FINANCIAL_SOURCES: FinancialSource[] = [
  {
    id: "cninfo",
    name: "巨潮资讯网",
    url: "https://www.cninfo.com.cn/new/index",
    description: "A股上市公司官方信息披露平台，包含公告、定期报告、财务数据、股东信息、公司治理等",
    bestFor: ["公司公告", "年报", "季报", "财务数据", "股东变动", "IPO", "增发", "分红", "公司治理"],
  },
  {
    id: "sse",
    name: "上海证券交易所",
    url: "https://www.sse.com.cn",
    description: "上交所官方网站，沪市上市公司、债券、基金、交易数据",
    bestFor: ["沪市行情", "交易规则", "上市公司列表", "债券信息", "市场统计"],
  },
  {
    id: "szse",
    name: "深圳证券交易所",
    url: "https://www.szse.cn",
    description: "深交所官方网站，深市上市公司、创业板、中小板数据",
    bestFor: ["深市行情", "创业板", "交易数据", "上市公司列表"],
  },
]
