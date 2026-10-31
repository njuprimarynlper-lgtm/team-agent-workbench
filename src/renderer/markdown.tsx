import React, { createContext, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from './math-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink } from 'lucide-react';
import { loadMarkdownImage, markdownImageSource } from './markdown-images';
import { MermaidDiagram } from './mermaid-diagram';
import { isMermaidSource, prepareDiagramMarkdown } from './mermaid-source';
import { CopyTextButton } from './copy-text-button';
import { SessionFilesDialog } from './session-files';
import { markdownLinkTarget, revealMarkdownAnchor } from './markdown-links';

type MarkdownContext = { sessionId?: string; openFile?: (path: string) => void | Promise<void>; conversation?: boolean };
const context = createContext<MarkdownContext>({});

function MarkdownLink({ href, children, node, ...props }: React.ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const { openFile, sessionId } = useContext(context), target = markdownLinkTarget(href);
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const key = JSON.stringify([sessionId, href]), error = failure?.key === key ? failure.message : undefined;
  const open = async (element: HTMLElement) => {
    setFailure(undefined);
    try {
      if (target.kind === 'unsupported') throw new Error('链接地址为空或不受支持；请使用网页、本地文件路径或本条回复内的标题链接');
      if (target.kind === 'web') await window.workbench.call('open.link', target.value);
      else if (target.kind === 'anchor') revealMarkdownAnchor(element, target.value);
      else {
        if (!openFile) throw new Error('请在所属会话中打开文件，当前页面没有关联的文件目录');
        await openFile(target.value);
      }
    } catch (reason) {
      setFailure({ key, message: reason instanceof Error ? reason.message : '链接打开失败，请稍后重试' });
    }
  };
  return <>{target.kind === 'unsupported'
    ? <button type="button" className="markdown-link-unsupported" title="此链接地址为空或不受支持，点击查看说明" onClick={event => void open(event.currentTarget)}>{children}</button>
    : <a {...props} href={target.value} title={props.title || target.value} onClick={event => { event.preventDefault(); void open(event.currentTarget); }} onAuxClick={event => { event.preventDefault(); if (event.button === 1) void open(event.currentTarget); }}>{children}{target.kind === 'web' && <ExternalLink size={11}/>}</a>}
    {error && <span className="markdown-link-error" role="alert">{error}<button type="button" aria-label="关闭链接提示" onClick={() => setFailure(undefined)}>×</button></span>}
  </>;
}

function MarkdownImage({ src, alt, title }: React.ComponentPropsWithoutRef<'img'>) {
  const { sessionId } = useContext(context), source = typeof src === 'string' ? src : '';
  const image = markdownImageSource(source), [attempt, retry] = useState(0);
  const key = JSON.stringify([sessionId, source, attempt]);
  const [loaded, setLoaded] = useState<{ key: string; url?: string; error?: string }>(), [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (markdownImageSource(source).kind !== 'local' || !sessionId) return;
    let active = true;
    void loadMarkdownImage(source, sessionId, (id, path) => window.workbench.call('session.file.preview', { id, path })).then(
      url => { if (active) setLoaded({ key, url }); },
      error => { if (active) setLoaded({ key, error: error instanceof Error ? error.message : '图片读取失败' }); },
    );
    return () => { active = false; };
  }, [source, sessionId, attempt]);
  const current = loaded?.key === key ? loaded : undefined;
  const url = image.kind === 'direct' ? image.url : current?.url;
  const error = failed === key ? '图片加载失败，请检查文件或网络后重试' : image.kind === 'unsupported' ? '图片地址为空或不受支持' : image.kind === 'local' && !sessionId ? '请在所属会话中查看本机图片' : current?.error;
  return <span className="markdown-image-block">{url && !error ? <img key={key} src={url} alt={alt || '图片'} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(key)}/> : <span className="markdown-image-status" role="status"><span>{error ? `无法显示图片：${alt || '附件'}` : `正在加载图片：${alt || '附件'}`}</span>{error && <><small>{error}</small>{image.kind !== 'unsupported' && (image.kind === 'direct' || sessionId) && <button type="button" className="text-button" onClick={() => retry(value => value + 1)}>重试加载图片</button>}</>}</span>}</span>;
}

function MarkdownPre({ children }: React.ComponentPropsWithoutRef<'pre'>) {
  const { conversation } = useContext(context);
  if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(children)) {
    const { className, children: content } = children.props;
    const language = /\blanguage-([^\s]+)/.exec(className || '')?.[1];
    if (typeof content === 'string' && isMermaidSource(content, language)) return <MermaidDiagram source={content.replace(/\n$/, '')}/>;
    if (conversation && typeof content === 'string') return <section className="markdown-code-block" aria-label={language ? language + ' 代码' : '代码'}><header><span>{language || '代码'}</span><CopyTextButton text={content.replace(/\n$/, '')} label="复制代码" caption/></header><pre>{children}</pre></section>;
  }
  return <pre>{children}</pre>;
}

function MarkdownTable({ children }: React.ComponentPropsWithoutRef<'table'>) {
  const { conversation } = useContext(context);
  const table = <table>{children}</table>;
  return conversation ? <div className="markdown-table">{table}</div> : table;
}

// Stable component identities keep already-loaded images and diagrams mounted as a reply streams.
const components: Components = { a: MarkdownLink, img: MarkdownImage, pre: MarkdownPre, table: MarkdownTable };
export function Markdown({ text, openFile, sessionId, conversation }: { text: string } & MarkdownContext) {
  const [file, setFile] = useState<{ sessionId: string; path: string }>();
  const preview = openFile ?? (sessionId ? (path: string) => setFile({ sessionId, path }) : undefined);
  return <context.Provider value={{ sessionId, openFile: preview, conversation }}><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => {
    if (key === 'src') return markdownImageSource(url).kind === 'unsupported' ? '' : url;
    const target = markdownLinkTarget(url);
    return target.kind === 'unsupported' ? '' : target.value;
  }} components={components}>{prepareDiagramMarkdown(text)}</ReactMarkdown></div>
    {file && file.sessionId === sessionId && createPortal(<SessionFilesDialog key={JSON.stringify(file)} sessionId={file.sessionId} initialPath={file.path} close={() => setFile(undefined)}/>, document.body)}
  </context.Provider>;
}
