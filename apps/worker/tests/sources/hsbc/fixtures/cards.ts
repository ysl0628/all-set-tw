// 去識別化 fixture：欄位名稱、格式與語意取自 2026-10-03 登入後唯讀查詢的實際回應；
// 卡號、識別碼、金額與商店皆已替換。`isPositive: true` 為消費，`false` 為繳款；
// 未入帳交易的 postedDate 為銀行的佔位值 `0002-11-30T00:00`。
export const hsbcCard = {
  id: "100001",
  imageUrl: "https://example.invalid/card.jpg",
  name: "滙豐旅人御璽卡",
  maskedCardNumber: "4000-****-****-1234",
  outstandingBalance: 12345,
  paymentDueDate: "27-09-2026",
  blockCode: "",
  cardStatus: "2",
  cardStatusReported: "0",
  isPrimaryCard: true,
  cardStatusDisplay: "ACTIVATED",
  minimumPayableAmount: 1000,
  statementDate: null,
  cardType: "461",
  primaryCustomerNumber: "000000000000",
  supplementaryCustomerNumber: "",
  identityNumber: "A12***0000",
  accountNumber: "000000000000000",
};

export const hsbcCardDetail = {
  productName: "滙豐旅人御璽卡",
  cardNumber: "4000-****-****-1234",
  outstandingBalance: "12,345",
  details: [
    { key: "Credit Limit", value: "200,000 TWD" },
    { key: "Available Credit Limit", value: "187,655 TWD" },
    { key: "Unbilled Transactions", value: "12,345 TWD" },
  ],
  paymentDueDate: "27-09-2026",
};

const statement = (
  year: string,
  month: string,
  total: string,
  minimum: string,
) => ({
  nationalId: "A12***0000",
  paymentKey: "0000000000000000",
  cardType: "V7",
  stmtMo: month,
  stmtYr: year,
  pmtDue: `${year}/${month}/27`,
  curTotAmt: total,
  minAmt: minimum,
  stmtDate: `${year}/${month}/09`,
  intRate: "14.980%",
  creditLmt: "200000",
  cashAdvLmt: "100000",
  preBal: "0",
  preAdjAmt: "0",
  preTotAmt: "0",
  curIncExpense: total,
  curOthExpense: "0",
});

// 銀行回傳最近 12 期，由舊到新排列。
export const hsbcStatements = [
  statement("2026", "05", "3000", "1000"),
  statement("2026", "06", "4500", "1000"),
  statement("2026", "07", "-120", "0"),
  statement("2026", "08", "8000", "1000"),
  statement("2026", "09", "9876", "1000"),
];

export const hsbcUnposted = [
  {
    description: "ＷＷＷ．ＧＲＡＢ．ＣＯＭＢＡＮＧＫＯＫ",
    amount: "140 TWD",
    isPositive: true,
    postedDate: "0002-11-30T00:00",
    transactionDate: "2026-10-03T00:00",
    isForeign: true,
    foreignAmount: "148 THB",
    ntdAmount: "140 TWD",
  },
  {
    description: "ＷＷＷ．ＧＲＡＢ．ＣＯＭＢＡＮＧＫＯＫ",
    amount: "140 TWD",
    isPositive: true,
    postedDate: "0002-11-30T00:00",
    transactionDate: "2026-10-03T00:00",
    isForeign: true,
    foreignAmount: "148 THB",
    ntdAmount: "140 TWD",
  },
  {
    description: "測試商店股份有限公司",
    amount: "1,050 TWD",
    isPositive: true,
    postedDate: "2026-09-12T00:00",
    transactionDate: "2026-09-10T00:00",
    isForeign: false,
    foreignAmount: "0 TWD",
    ntdAmount: "1,050 TWD",
  },
];

export const hsbcPostedPage0 = [
  {
    description: "國外交易手續費ＴＥＳＴＡＩＲ１２３４５６",
    amount: "38 TWD",
    isPositive: true,
    postedDate: "2026-09-08T00:00",
    transactionDate: "2026-09-06T00:00",
    isForeign: false,
    foreignAmount: "0 TWD",
    ntdAmount: "38 TWD",
  },
  {
    description: "全國繳費網繳款",
    amount: "2,500 TWD",
    isPositive: false,
    postedDate: "2026-08-24T00:00",
    transactionDate: "2026-08-24T00:00",
    isForeign: false,
    foreignAmount: "0 TWD",
    ntdAmount: "2,500 TWD",
  },
];

export const hsbcPostedPage1 = [
  {
    description: "回溯範圍內的舊消費",
    amount: "500 TWD",
    isPositive: true,
    postedDate: "2026-07-06T00:00",
    transactionDate: "2026-07-04T00:00",
    isForeign: false,
    foreignAmount: "0 TWD",
    ntdAmount: "500 TWD",
  },
  {
    description: "超過三個月的消費",
    amount: "999 TWD",
    isPositive: true,
    postedDate: "2026-06-03T00:00",
    transactionDate: "2026-06-01T00:00",
    isForeign: false,
    foreignAmount: "0 TWD",
    ntdAmount: "999 TWD",
  },
];
