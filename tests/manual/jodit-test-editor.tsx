import React, { useState, useRef, useMemo } from 'react';
import JoditEditor from 'jodit-react';
import { createRoot } from 'react-dom/client';

export const TestEditor = () => {
    const editor = useRef(null);
    const [content, setContent] = useState('');

    const config = useMemo(() => ({
        readonly: false, 
        placeholder: 'Start typing...',
        iframe: false, // Default is false, which means it uses standard DOM 
        toolbarAdaptive: false
    }), []);

    return (
        <div style={{ padding: 40}}>
          <JoditEditor
              ref={editor}
              value={content}
              config={config}
              tabIndex={1}
              onBlur={newContent => setContent(newContent)}
          />
        </div>
    );
};

const root = createRoot(document.getElementById('root')!);
root.render(<TestEditor />);
