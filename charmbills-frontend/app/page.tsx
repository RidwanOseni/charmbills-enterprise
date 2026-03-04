'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Zap, Lock, Clock } from 'lucide-react'

export default function HomePage() {
  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Hero Section */}
      <section className="flex-1 max-w-6xl mx-auto w-full px-6 py-20 flex flex-col items-center text-center">
        <h1 className="text-5xl md:text-6xl font-bold text-primary mb-6 text-balance">
          Pay Your Team with Bitcoin.
          <br />
          Automatically.
        </h1>
        <p className="text-xl text-foreground mb-10 max-w-2xl text-balance leading-relaxed">
          No more payroll runs. No more chasing invoices. Just code that pays your employees and
          freelancers on time, every time.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 mb-20">
          <Link href="/dashboard">
            <Button
              size="lg"
              className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-6 text-lg font-semibold rounded-lg"
            >
              Start Paying
            </Button>
          </Link>
          <Link href="/worker">
            <Button
              variant="outline"
              size="lg"
              className="px-8 py-6 text-lg font-semibold border-2 border-secondary text-secondary hover:bg-secondary/10 rounded-lg"
            >
              Worker Login
            </Button>
          </Link>
        </div>

        {/* Benefit Cards */}
        <div className="grid md:grid-cols-3 gap-6 w-full">
          {/* Card 1: Save on fees */}
          <Card className="p-8 bg-card border border-border rounded-xl hover:shadow-lg transition">
            <div className="flex justify-center mb-6">
              <div className="p-3 bg-secondary/10 rounded-lg">
                <Zap className="w-8 h-8 text-secondary" />
              </div>
            </div>
            <h3 className="text-2xl font-bold text-primary mb-3">Save 90% on fees</h3>
            <p className="text-foreground leading-relaxed">
              Pay multiple workers in a single transaction. Batch payments together and save on
              blockchain fees with every payroll run.
            </p>
          </Card>

          {/* Card 2: Privacy */}
          <Card className="p-8 bg-card border border-border rounded-xl hover:shadow-lg transition">
            <div className="flex justify-center mb-6">
              <div className="p-3 bg-accent/10 rounded-lg">
                <Lock className="w-8 h-8 text-accent" />
              </div>
            </div>
            <h3 className="text-2xl font-bold text-primary mb-3">Privacy by default</h3>
            <p className="text-foreground leading-relaxed">
              Salaries are encrypted and visible only to the employer and worker. Complete control
              over financial data.
            </p>
          </Card>

          {/* Card 3: Instant settlement */}
          <Card className="p-8 bg-card border border-border rounded-xl hover:shadow-lg transition">
            <div className="flex justify-center mb-6">
              <div className="p-3 bg-primary/10 rounded-lg">
                <Clock className="w-8 h-8 text-primary" />
              </div>
            </div>
            <h3 className="text-2xl font-bold text-primary mb-3">No bank delays</h3>
            <p className="text-foreground leading-relaxed">
              Payments settle instantly when conditions are met. No waiting for banks or payment
              processors.
            </p>
          </Card>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-card mt-20">
        <div className="max-w-6xl mx-auto px-6 py-12 flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="text-sm text-muted-foreground">© 2024 CharmBills. All rights reserved.</div>
          <div className="flex gap-6">
            <Link href="/dashboard" className="text-sm text-foreground hover:text-primary transition font-medium">
              Employer Dashboard
            </Link>
            <Link href="/worker" className="text-sm text-foreground hover:text-primary transition font-medium">
              Worker Portal
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}