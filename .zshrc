#=====================================
# Load external ZSH plugins
#=====================================

# Add custom functions to the function path. NB: we deliberately do NOT run `compinit`
# here. Some plugins manage compinit itself, and calling it ourselves makes the plugin
# throw away its completion cache and rebuild it on every new shell — which is what
# makes new tabs hang. Completion is initialised further down, guarded so it still works
# without the plugin.
fpath+=~/.zfunc

# Download Znap, if it's not there yet.
[[ -r ~/znap-plugins/znap/znap.zsh ]] ||
  git clone --depth 1 -- https://github.com/marlonrichert/zsh-snap.git ~/znap-plugins/znap
source ~/znap-plugins/znap/znap.zsh  # Start Znap

# Autocomplete plugin. This block owns the completion system while present, and is safe
# to delete wholesale: the guarded `compinit` lower down takes over automatically if
# it's gone, so no other edits are needed.
#
# PINNED. We hold this at a known-good commit rather than tracking main. Commit bbba73e
# ("Add support for tiny terminals") hangs every new shell on zsh 5.9 — you can't open a
# tab. The commit below loads cleanly and has the later completion-widget/fd fixes, so
# don't move it to an older one. To bump it deliberately: cd into the repo, `git pull`,
# test, then update this hash. The rev-parse guard re-pins if `znap pull` ever moves it.
_autocomplete_commit=20f6c34f20270084b21211428afb6d2534aae8e9
[[ -r ~/znap-plugins/marlonrichert/zsh-autocomplete ]] ||
  znap clone marlonrichert/zsh-autocomplete
[[ $(git -C ~/znap-plugins/marlonrichert/zsh-autocomplete rev-parse HEAD 2>/dev/null) == $_autocomplete_commit ]] ||
  git -C ~/znap-plugins/marlonrichert/zsh-autocomplete checkout -q $_autocomplete_commit 2>/dev/null
unset _autocomplete_commit
znap source zsh-autocomplete
zstyle ':autocomplete:*' append-semicolon no
bindkey -M menuselect '\r' .accept-line
bindkey -a 'j' down-line-or-search
bindkey -a 'k' up-line-or-search

# Another autocomplete plugin
[[ -r ~/znap-plugins/zsh-users/zsh-autosuggestions ]] ||
  znap clone zsh-users/zsh-autosuggestions
znap source zsh-autosuggestions
bindkey '§' autosuggest-accept
bindkey -M menuselect  '^[[D' .backward-char  '^[OD' .backward-char
bindkey -M menuselect  '^[[C'  .forward-char  '^[OC'  .forward-char

# Syntax highlighting plugin
[[ -r ~/znap-plugins/zsh-users/zsh-syntax-highlighting ]] ||
  znap clone zsh-users/zsh-syntax-highlighting
znap source zsh-syntax-highlighting


#=========================================
# General plugin-agnostic ZSH keybindings
#=========================================

bindkey '^[[H' beginning-of-line  # Home moves cursor to the beginning of the line
bindkey '^[[F' end-of-line  # End moves cursor to the end of the line
bindkey '^[[1;3D' backward-word  # Ctrl+left moves cursor one word to the left
bindkey '^[[1;3C' forward-word  # Ctrl+right moves cursor one word to the right


#=====================
# Set up Git commands
#=====================

# A bunch of fancy ZSH code to enable git integration. Taken from
# https://scriptingosx.com/2019/07/moving-to-zsh-06-customizing-the-zsh-prompt/
autoload -Uz vcs_info
setopt prompt_subst
zstyle ':vcs_info:*' enable git
precmd_vcs_info() { vcs_info }
precmd_functions+=( precmd_vcs_info )

# Set prompt to be "[current_branch] [parent_path/current_path]$". Here %b is the
# current branch name, and %F{xxx} ... %f colours the text colour xxx, where 170 is the
# colour "orchid" and 154 the colour "GreenYellow". See all colours available here:
# https://jonasjacek.github.io/colors/
zstyle ':vcs_info:git:*' formats '%F{170}[%b]%f '
PROMPT=\$vcs_info_msg_0_
PROMPT+='%F{154}%2~$ %f'


#========================
# iTerm2 tab title (basename of current dir or git repo)
#========================

# Sets the iTerm2 tab title to show the full current directory path.
# Requires "Applications in terminal may change the title" to be checked
# in iTerm2 Settings → Profiles → [profile] → General → Title.
set_tab_title() {
  local title
  
  # If connected via SSH, show the remote host name (e.g., "sparkie")
  if [ -n "$SSH_CONNECTION" ] || [ -n "$SSH_CLIENT" ]; then
    # On the remote machine, hostname -s gives the short host name
    title=$(hostname -s 2>/dev/null || echo "ssh")
  else
    # Local session: show only current directory name (basename)
    title=$(basename "$PWD")
  fi
  
  # Set tab title using combined icon+window title sequence
  echo -ne "\033]0;$title\007"
}

# Run on every prompt and directory change
chpwd_functions+=(set_tab_title)
precmd_functions+=(set_tab_title)
set_tab_title  # Set it now for the current session


#========================
# SSH wrapper to pass config alias to remote
#========================

#========================
# SSH wrapper
#========================
# Note: Remote servers set their own tab titles, which override local settings.
# Can't change this without modifying the remote server's config.


#=============================
# Set up general ZSH settings
# ============================

# SSH autocompletion
_ssh_complete() {
    local cur prev opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    opts=$(awk '/^Host / {print $2}' ~/.ssh/config)

    COMPREPLY=( $(compgen -W "${opts}" -- ${cur}) )
    return 0
}
complete -F _ssh_complete ssh

# Docker autocompletion
fpath=(/Users/dansmart/.docker/completions $fpath)

# Initialise the completion system — but ONLY if a plugin hasn't already taken it over
if [[ $functions[compdef] != *_autocomplete__compdef* ]]; then
  autoload -Uz compinit
  compinit
fi

# Bun autocompletion
[ -s "/Users/dansmart/.bun/_bun" ] && source "/Users/dansmart/.bun/_bun"


#==================================
# Set up general terminal settings
#==================================

# Set up Bun
export BUN_INSTALL="$HOME/.bun"

# Set up PATH
export PATH="/opt/homebrew/bin:$PATH"
export PATH="/usr/local/sbin:$PATH"
export PATH="$HOME/.poetry/bin:$PATH"
export PATH="$HOME/Applications/nvim/bin:$PATH"
export PATH="$PATH:/Users/dan/.local/bin"
export PATH="$PATH:/Users/dan/.cache/lm-studio/bin"
export PATH="$HOME/.cargo/bin:$PATH"
export PATH="/usr/local/opt/openjdk/bin:$PATH"
export PATH="$PATH:/Users/dan/.lmstudio/bin"
export PATH="$PATH:/Users/dan/.local/share/nvim/mason/bin"
export PATH="$PATH:/Users/dansmart/.lmstudio/bin"
export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/.local/share/../bin:$PATH"
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
export PATH="$BUN_INSTALL/bin:$PATH"

# Ensure openblas has been set up, which is used for Numpy to work
export OPENBLAS="$(brew --prefix openblas)"

# Enable MPS fallback
export PYTORCH_ENABLE_MPS_FALLBACK="1"

# NVM directory — lazy-loaded. Sourcing nvm.sh eagerly adds ~600ms to every new shell
# (it dominates startup). Instead we define lightweight shims for nvm/node/npm/npx; the
# first time you run one, it sources the real nvm, removes the shims, and re-runs your
# command. Startup stays snappy.
export NVM_DIR="$HOME/.config/nvm"
# Each shim unsets ALL four shims first, then sources nvm, then runs the real
# command. Self-contained (no separate _load_nvm to go missing) and unsets
# itself before running, so a missing nvm.sh falls through to PATH instead of
# recursing into the shim forever.
for _cmd in nvm node npm npx; do
  eval "${_cmd}() {
    unset -f nvm node npm npx
    [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"
    [ -s \"\$NVM_DIR/bash_completion\" ] && \. \"\$NVM_DIR/bash_completion\"
    ${_cmd} \"\$@\"
  }"
done
unset _cmd


#=======================
# Convenience shortcuts
#=======================

# Backup dotfiles
rc(){
  cd ~/gitsky/dotfiles
  git add .
  git commit -m "chore: Update dot files"
  git pull
  git push
  echo "Dot files synced up!"
  cd -
}

# Activate a virtual environment, or build it if it is not there
vv(){
  if [ ! -d '.venv' ]
  then
    python3 -m venv --upgrade-deps .venv
    source .venv/bin/activate
    if [ -f 'requirements.txt' ]
    then
      python3 -m pip install -r requirements.txt
    fi
  else
    source .venv/bin/activate
  fi
}

newproject(){
  cookiecutter -f gh:alexandrainst/alexandra-ml-template -o "$HOME/gitsky"
  cd "$HOME/gitsky"
}

online() {
    if curl -s --head --max-time 1 --connect-timeout 1 http://captive.apple.com/hotspot-detect.html > /dev/null; then
        echo "You are online"
    else
        echo "You are offline"
    fi
}


#=========
# Aliases
#=========

alias ls='eza'
alias vim='nvim'
alias gt='cd ~/gitsky'
alias pc='cd ~/pCloud\ Drive'
alias ll='ls -l'
alias la='ls -ah'
alias lla='ls -lah'
alias gs='git status --short'
alias ga='git add'
alias gd='git diff'
alias gb='git branches'
alias gc='git checkout'
alias gl='git log --graph --pretty=format:"%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset" --abbrev-commit --date=relative'
alias python='python3'


#=========
# Secret environment variables
#=========

# Load secret environment variables from .env
if [ -f ~/.env ] && [ -s ~/.env ] && grep -qvE '^\s*(#|$)' ~/.env
then
    export $(cat ~/.env | xargs)
fi
