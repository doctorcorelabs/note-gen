import { platform } from '@/lib/platform';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const OpenBroswer = ({ type = 'link', title, url, className }: { type?: 'link' | 'button', title: string, url: string, className?: string }) => {
  return (
    type === 'button' ?
    <Button className={className} onClick={() => {platform.opener.openUrl(url)}}>{title}</Button> :
    <Link 
      className={cn('underline hover:text-foreground', className)}
      href={'#'}
      onClick={() => {platform.opener.openUrl(url)}}
    >{title}</Link>
  );
};
