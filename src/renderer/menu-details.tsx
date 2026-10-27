import React, { useRef } from 'react';
import { useDetailsMenu } from './popup-dismiss';

export function MenuDetails(props: React.ComponentPropsWithoutRef<'details'>) {
  const root = useRef<HTMLDetailsElement>(null); useDetailsMenu(root);
  return <details {...props} ref={root}/>;
}
