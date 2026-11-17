import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "P2P Price Radar | Cambodia USDT rates",
  description:
    "Compare USDT P2P buy and sell offers across payment methods on Binance, OKX, Bybit, and Bitget.",
  applicationName: "P2P Price Radar",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
