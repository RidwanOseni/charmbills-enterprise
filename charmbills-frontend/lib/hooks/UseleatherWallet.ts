import { useState, useCallback } from 'react';

export function useLeatherWallet() {
    const [wallet, setWallet] = useState({
        address: null as string | null,
        publicKey: null as string | null,
        connected: false,
        error: null as string | null,
    });

    const connect = useCallback(async () => {
        try {
            if (!(window as any).LeatherProvider) {
                throw new Error("Leather Wallet not found.");
            }
            // Request addresses from Leather
            const response = await (window as any).LeatherProvider.request("getAddresses");
            
            // SECURITY: Strictly filter for Taproot (p2tr) for Schnorr support [8]
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