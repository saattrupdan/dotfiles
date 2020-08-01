" Set colour scheme
colorscheme evening

" Automatically change the current working directory to the present file
set autochdir

" Enable line numbering
set number

" Set font for gVim
set guifont=Monospace\ 10

" Set editor size; the extra 4 lines is because of line numbering
set lines=100 columns=84

" No menu bar
set guioptions-=m  

" No toolbar
set guioptions-=T  

" No scrollbar
set guioptions-=r  

" Tab size
set tabstop=2 

" Shift size using > and <
set shiftwidth=2 

" Convert tabs into spaces
set expandtab 

" Enable auto-indent
set ai

" Map ½ to $ to enable easier navigation
map ½ $
imap ½ $

" Set the standard editor to be gVim when using rmvim
let g:rmvim_cmd = 'gvim'


"==============================
" Deal with clipboard nonsense
"==============================

" Set the gvim clipboard to be the standard clipboard
set clipboard=unnamed 

" Disable automatic copying selected text
" Here guioptions handles the GUI case and clipboard the other
set guioptions-=a
set clipboard-=autoselect

" Always copy into the standard clipboard register
vnoremap y "+y

" Disable copying when deleting with 'd'
nnoremap d "_d
vnoremap d "_d

" Set 'p' to paste into selection without copying the previous content
vnoremap p "_dP


"=========================================
" Load external Vim plugins with vim-plug
"=========================================

call plug#begin('~/.vim/plugged')

  " File manager
  Plug 'preservim/nerdtree'

  " Tab completion
  Plug 'ervandew/supertab'

  " Dealing with LaTeX files
  Plug 'lervag/vimtex'

  " Setting up remote Vim
  Plug 'wannesm/rmvim.vim'

call plug#end()


"===============
" Custom macros
"===============

function EnableTeXKeyBindings()
  " Enables key bindings which are nice for TeXing
  so ~/.texrc
  echo 'LaTeX key bindings set!'
endfunction

function MarkdownToPDF()
  " Compiles and saves a markdown file as pdf
  w
  !pandoc '%' -o '%:r.pdf'
endfunction

function Compile()
  " Saves and compiles the current document
  w
  !pdflatex %
endfunction

function BibTeXCompile()
  " Saves, compiles and bibtex-compiles the current document
  w
  !pdflatex % && bibtex %:r && pdflatex % && pdflatex %
endfunction

function CompileMaster()
  " PhD specific macro that saves, compiles, bibtex-compiles, git adds,
  " commits, pulls and pushes the document
  w
  let title = input('Enter commit message: ')
  execute "!cd ~/gitsky/phd && pdflatex main.tex && bibtex main && pdflatex main.tex && pdflatex main.tex && git add . && git commit -m '" . title . "' && git pull && git push"
endfunction

command P call MarkdownToPDF()
command T call EnableTeXKeyBindings()
command C call Compile()
command CB call BibTeXCompile()
command CM call CompileMaster()
