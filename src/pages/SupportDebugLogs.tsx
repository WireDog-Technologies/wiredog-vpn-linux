import React from 'react';
import { ChevronLeft, Monitor, Server, Info } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useElectron } from '@/context/ElectronContext';

const SupportDebugLogs: React.FC = () => {
  const navigate = useNavigate();
  const { openAppLogs, openServiceLogs } = useElectron();

  return (
    <div className="h-full p-6 star-pattern overflow-auto">
      {/* Back Button */}
      <button
        onClick={() => navigate(-1)}
        className="text-muted-foreground hover:text-foreground transition-colors mb-4 p-0"
      >
        <ChevronLeft className="w-8 h-8" />
      </button>

      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="font-display text-4xl tracking-wider text-foreground mb-2">
            DEBUG LOGS
          </h1>
          <p className="text-muted-foreground">
            Open log directories in your file explorer for troubleshooting
          </p>
        </div>

        {/* Log Options */}
        <Card className="p-6 mb-6">
          <div className="space-y-3">
            {/* Application Logs */}
            <button
              onClick={() => openAppLogs()}
              className="w-full flex items-center gap-3 p-4 -m-4 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center flex-shrink-0">
                <Monitor className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="text-left flex-1">
                <p className="font-medium">Application Logs</p>
                <p className="text-sm text-muted-foreground">
                  Electron app logs — window management, IPC, updates
                </p>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180 flex-shrink-0" />
            </button>

            <Separator />

            {/* Service Logs */}
            <button
              onClick={() => openServiceLogs()}
              className="w-full flex items-center gap-3 p-4 -m-4 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center flex-shrink-0">
                <Server className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="text-left flex-1">
                <p className="font-medium">Service Logs</p>
                <p className="text-sm text-muted-foreground">
                  VPN service logs — connections, WireGuard, firewall
                </p>
              </div>
              <ChevronLeft className="w-5 h-5 text-muted-foreground rotate-180 flex-shrink-0" />
            </button>
          </div>
        </Card>

        {/* Info Section */}
        <Card className="p-4 bg-muted/30">
          <div className="flex gap-3">
            <Info className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-medium mb-1">About Log Files</h3>
              <p className="text-sm text-muted-foreground">
                Logs are automatically rotated to prevent excessive disk usage. Application logs
                and service logs are stored separately. These files are helpful for troubleshooting
                issues with support staff.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default SupportDebugLogs;
