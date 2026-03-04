import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { WalletProvider } from '@/lib/WalletContext'
import { Header } from '@/components/Header'

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans', 
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
})

export const metadata: Metadata = {
  title: 'CharmBills - Bitcoin Payroll',
  description: 'Automated payroll for employees and freelancers.',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {/* Wrap everything in the Wallet Provider to enable global state */}
        <WalletProvider>
          <Header />
          <main className="min-h-screen bg-background">
            {children}
          </main>
        </WalletProvider>
      </body>
    </html>
  )
}