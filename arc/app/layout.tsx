import "./globals.css";

export const metadata = {
  title: "لعبة السبيطة",
  description: "لعبة ورق جماعية",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
