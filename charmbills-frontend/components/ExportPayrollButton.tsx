'use client'

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';

interface ExportPayrollButtonProps {
  workers: any[];
  registeredDepts: any[];
  decryptedDeptNames: Record<string, string>;
}

interface ExportRecord {
  workerName: string;
  workerAddress: string;
  role: string;
  department: string;
  departmentId: string;
  salarySats: number;
  status: string;
  lastMintedPeriod: string | null;
  lastMintedDate: string | null;
  engagementType: string;
  historicalTokensCount: number;
  totalPaidSats: number;
}

export function ExportPayrollButton({ workers, registeredDepts, decryptedDeptNames }: ExportPayrollButtonProps) {
  const [isExporting, setIsExporting] = useState(false);

  // Helper to get department display name
  const getDepartmentDisplayName = (dept: any): string => {
    if (dept.appId && decryptedDeptNames[dept.appId]) {
      const name = decryptedDeptNames[dept.appId];
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    if (dept.department) {
      return dept.department.charAt(0).toUpperCase() + dept.department.slice(1);
    }
    if (dept.ticker) {
      const tickerName = dept.ticker.replace('-PAY', '');
      return tickerName.charAt(0).toUpperCase() + tickerName.slice(1).toLowerCase();
    }
    return 'Department';
  };

  // Helper to get department name by planId
  const getDepartmentNameByPlanId = (planId: string): string => {
    const dept = registeredDepts.find(d => d.appId === planId);
    if (!dept) return 'Unknown Department';
    return getDepartmentDisplayName(dept);
  };

  // Calculate total paid sats from historicalTokens
  const calculateTotalPaid = (historicalTokens: any[]): number => {
    if (!historicalTokens || !Array.isArray(historicalTokens)) return 0;
    // Sum up all payment amounts if they exist in historicalTokens
    // For now, count each historical token as 1 period of salary
    // In the future, store amount in historicalTokens when structured payment history is implemented
    return historicalTokens.length;
  };

  const generateCSV = (records: ExportRecord[]): string => {
    const headers = [
      'Worker Name',
      'Worker Address',
      'Role',
      'Department',
      'Salary (sats/period)',
      'Status',
      'Last Paid Period',
      'Last Paid Date',
      'Engagement Type',
      'Total Payments Received',
      'Total Paid (periods)'
    ];

    const rows = records.map(record => [
      record.workerName,
      record.workerAddress,
      record.role,
      record.department,
      record.salarySats.toString(),
      record.status,
      record.lastMintedPeriod || 'Never',
      record.lastMintedDate || 'Never',
      record.engagementType,
      record.historicalTokensCount.toString(),
      record.totalPaidSats.toString()
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    return csvContent;
  };

  const generateJSON = (records: ExportRecord[]): string => {
    return JSON.stringify(records, null, 2);
  };

  const handleExport = async (format: 'csv' | 'json') => {
    console.log('[EXPORT] Starting payroll export...');
    setIsExporting(true);

    try {
      // Build export records from workers data
      const exportRecords: ExportRecord[] = workers.map(worker => {
        const departmentName = getDepartmentNameByPlanId(worker.planId);
        const departmentObj = registeredDepts.find(d => d.appId === worker.planId);
        
        // Parse historicalTokens if it's a string
        let historicalTokens: any[] = [];
        if (worker.historicalTokens) {
          try {
            historicalTokens = typeof worker.historicalTokens === 'string' 
              ? JSON.parse(worker.historicalTokens) 
              : worker.historicalTokens;
          } catch (e) {
            console.warn(`[EXPORT] Failed to parse historicalTokens for ${worker.walletAddress}`);
            historicalTokens = [];
          }
        }

        return {
          workerName: worker.name || 'Unnamed',
          workerAddress: worker.walletAddress,
          role: worker.role || 'Team Member',
          department: departmentName,
          departmentId: worker.planId || '',
          salarySats: worker.salarySats || 0,
          status: worker.status || 'pending',
          lastMintedPeriod: worker.lastMintedPeriod || null,
          lastMintedDate: worker.lastMintedPeriod ? new Date(worker.lastMintedPeriod).toLocaleDateString() : null,
          engagementType: worker.engagementType === 0 ? 'Time-based (Employee)' : 'Proof-based (Freelancer)',
          historicalTokensCount: historicalTokens.length,
          totalPaidSats: calculateTotalPaid(historicalTokens)
        };
      });

      console.log(`[EXPORT] Generated ${exportRecords.length} export records`);

      let content: string;
      let filename: string;
      let mimeType: string;

      if (format === 'csv') {
        content = generateCSV(exportRecords);
        filename = `payroll_export_${new Date().toISOString().split('T')[0]}.csv`;
        mimeType = 'text/csv';
      } else {
        content = generateJSON(exportRecords);
        filename = `payroll_export_${new Date().toISOString().split('T')[0]}.json`;
        mimeType = 'application/json';
      }

      // Create download link
      const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      console.log(`[EXPORT] ✅ Export completed: ${filename}`);
    } catch (error) {
      console.error('[EXPORT] Failed to export payroll data:', error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex gap-2">
      <Button
        onClick={() => handleExport('csv')}
        disabled={isExporting || workers.length === 0}
        variant="outline"
        className="border-secondary text-secondary hover:bg-secondary/10"
      >
        <Download className="w-4 h-4 mr-2" />
        {isExporting ? 'Exporting...' : 'Export CSV'}
      </Button>
      <Button
        onClick={() => handleExport('json')}
        disabled={isExporting || workers.length === 0}
        variant="outline"
        className="border-secondary text-secondary hover:bg-secondary/10"
      >
        <Download className="w-4 h-4 mr-2" />
        Export JSON
      </Button>
    </div>
  );
}