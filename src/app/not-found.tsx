'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { isMobileDevice } from '@/lib/check';
import { platform } from '@/lib/platform';

export default function NotFound() {
  const router = useRouter();
  const mobile = isMobileDevice()
  const fallbackPath = mobile ? '/mobile/record' : '/core/main'
  const fallbackLabel = mobile ? 'Record' : 'Main'
  const [countdown, setCountdown] = useState(2);

  async function resetRouteStore() {
    const store = await platform.store.load('store.json');
    await store.set('currentPage', fallbackPath)
    await store.delete('lastSettingPage')
    await store.delete('lastRecordPage')
    await store.save()
  }

  // Client navigation only (DA-15-03). A full reload to the fallback
  // deep route 404s on the static nginx deploy while try_files is
  // absent, and error_page alone would re-run this 2-second countdown
  // forever. This fix must land in one package with the nginx
  // try_files fix (DL1, DA-15-02/04, AD-188): try_files must try
  // $uri.html before $uri/, plus error_page 404 /404.html. Never land
  // error_page without try_files.
  async function returnToFallback() {
    await resetRouteStore()

    router.replace(fallbackPath)
  }

  useEffect(() => {
    void resetRouteStore()
  }, [fallbackPath])

  useEffect(() => {
    const timer = setTimeout(() => {
      void returnToFallback()
    }, 2000);

    const countdownInterval = setInterval(() => {
      setCountdown((prevCount) => {
        if (prevCount <= 1) {
          clearInterval(countdownInterval);
          return 0;
        }
        return prevCount - 1;
      });
    }, 1000);

    // Cleanup on component unmount
    return () => {
      clearTimeout(timer);
      clearInterval(countdownInterval);
    };
  }, [fallbackPath, router]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4">
      <h1 className="text-3xl font-bold mb-4">404 - Page Not Found</h1>
      <div className="text-center">
        <p className="mb-6">Redirecting to the {fallbackLabel} page in {countdown} seconds...</p>
        <Button onClick={() => void returnToFallback()}>Go to {fallbackLabel} Page Now</Button>
      </div>
    </div>
  );
}
