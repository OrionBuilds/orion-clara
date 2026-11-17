import type { Metadata } from "next";
import "./globals.css";
import Shell from "@/components/Shell";
import { OWNER_FIRST } from "@/lib/clara/owner";

export const metadata: Metadata = {
  title: "Clara",
  description: `${OWNER_FIRST}'s personal & executive assistant`,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <div className="relative z-10">
          <Shell>{children}</Shell>
        </div>
      </body>
    </html>
  );
}
