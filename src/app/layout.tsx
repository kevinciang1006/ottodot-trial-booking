import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ottodot — Trial Class Booking',
  description: 'Book a trial class, pay, and see confirmed rosters.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <nav className="border-b p-4 text-sm">
          <Link className="mr-4 underline" href="/">
            Book
          </Link>
          <Link className="underline" href="/admin">
            Rosters
          </Link>
        </nav>
        {children}
      </body>
    </html>
  )
}
