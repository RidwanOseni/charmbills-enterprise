'use client'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Wallet } from 'lucide-react'
import { useWallet } from '@/lib/WalletContext'
import { usePathname } from 'next/navigation'

export function Header() {
  const { address, walletConnected, connectWallet, disconnectWallet } = useWallet();
  const pathname = usePathname();

  // Helper to determine if a link is active
  const isActive = (path: string) => pathname === path;

  // Get page title for subtitle
  const getPageSubtitle = () => {
    if (pathname === '/dashboard') return 'Employer Dashboard';
    if (pathname === '/worker') return 'Worker Portal';
    if (pathname === '/treasury') return 'Treasury';
    return '';
  };

  return (
    <header className="border-b border-border bg-card sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-6 py-6 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold text-primary">₿</span>
            <Link href="/" className="text-2xl font-bold text-primary">
              CharmBills
            </Link>
          </div>
          {pathname !== '/' && (
            <p className="text-sm text-muted-foreground mt-1">{getPageSubtitle()}</p>
          )}
        </div>
        
        <nav className="hidden md:flex gap-6 absolute left-1/2 transform -translate-x-1/2">
          <Link href="/" className="text-sm text-foreground hover:text-primary transition font-medium">
            Home
          </Link>
          <Link 
            href="/dashboard" 
            className={`text-sm hover:text-primary transition font-medium ${
              isActive('/dashboard') ? 'text-primary font-bold' : 'text-foreground'
            }`}
          >
            Employer Dashboard
          </Link>
          <Link 
            href="/worker" 
            className={`text-sm hover:text-primary transition font-medium ${
              isActive('/worker') ? 'text-primary font-bold' : 'text-foreground'
            }`}
          >
            Worker Portal
          </Link>
          <Link 
            href="/treasury" 
            className={`text-sm hover:text-primary transition font-medium ${
              isActive('/treasury') ? 'text-primary font-bold' : 'text-foreground'
            }`}
          >
            Treasury
          </Link>
        </nav>
        
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-muted-foreground hidden sm:inline">
            {address ? `${address.substring(0, 8)}...${address.substring(address.length - 6)}` : 'Not Connected'}
          </span>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={walletConnected ? disconnectWallet : connectWallet} 
            className="flex items-center gap-2 rounded-lg"
          >
            <Wallet className="w-4 h-4" />
            {walletConnected ? 'Disconnect' : 'Connect'}
          </Button>
        </div>
      </div>
    </header>
  );
}