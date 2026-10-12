import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "logwatch",
  description: "Mac のログ件数の推移と異常検知",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
