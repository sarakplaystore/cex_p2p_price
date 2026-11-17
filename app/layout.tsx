import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "P2P Price Radar | ABA Bank rates",
  description:
    "Compare the best USDT P2P buy and sell offers on Binance, OKX, Bybit, and Bitget with ABA Bank payments.",
  applicationName: "P2P Price Radar",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
