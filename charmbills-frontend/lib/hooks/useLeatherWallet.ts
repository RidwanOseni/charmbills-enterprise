import { useState, useCallback } from 'react';

// Add type declaration for LeatherProvider
declare global {
  interface Window {
    LeatherProvider?: {
      request: (method: string, params?: any) => Promise<any>;
    };
  }
}

interface WalletState {
  address: string | null;
  publicKey: string | null;
  connected: boolean;
  error: string | null;
}

export function useLeatherWallet() {
  const [wallet, setWallet] = useState<WalletState>({
    address: null,
    publicKey: null,
    connected: false,
    error: null,
  });

  const connect = useCallback(async () => {
    try {
      if (!window.LeatherProvider) {
        throw new Error("Leather Wallet not found. Please install the extension.");
      }

      const response = await window.LeatherProvider.request("getAddresses");
      
      // Charms requires Taproot (p2tr) for Schnorr signatures [1, 2]
      const taprootAddr = response.result.addresses.find(
        (addr: any) => addr.type === 'p2tr'
      );

      if (!taprootAddr) {
        throw new Error("No Taproot address found. Please update Leather.");
      }

      setWallet({
        address: taprootAddr.address,
        publicKey: taprootAddr.publicKey,
        connected: true,
        error: null,
      });

      return taprootAddr.address;
    } catch (err: any) {
      setWallet(prev => ({ ...prev, error: err.message }));
      return null;
    }
  }, []);

  return { ...wallet, connect };
}