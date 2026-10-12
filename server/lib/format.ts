// サーバーとブラウザで表示がずれないよう、タイムゾーンを明示して整形する
const TIME_ZONE = "Asia/Tokyo";

const hhmm = new Intl.DateTimeFormat("ja-JP", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

const dateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: TIME_ZONE,
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const number = new Intl.NumberFormat("ja-JP");

export const formatTime = (t: number | Date) => hhmm.format(t);
export const formatDateTime = (t: number | Date) => dateTime.format(t);
export const formatNumber = (n: number) => number.format(n);
