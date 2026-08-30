import "./globals.css";
import { Providers } from "./providers";

export const metadata = {
  title: "Reconciliation Dashboard",
  description: "Order and payment reconciliation dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
