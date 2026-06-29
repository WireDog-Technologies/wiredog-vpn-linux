import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import RightSidebar from './RightSidebar';

const AppLayout: React.FC = () => {
  return (
    <div className="flex flex-col h-screen bg-background overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {/* Full Sidebar */}
        <div className="bg-card flex items-center h-full overflow-hidden">
          <Sidebar />
        </div>

        {/* Main Content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>

        {/* Right Sidebar */}
        <div className="bg-card flex items-center h-full overflow-hidden">
        <RightSidebar />
        </div>
      </div>
    </div>
  );
};

export default AppLayout;
