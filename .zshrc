#=====================================
# Load external ZSH plugins with Znap
#=====================================

# Set up Znap
if [ ! -d ~/znap-plugins ]
then
    git clone --depth 1 -- https://github.com/marlonrichert/zsh-snap.git
    source zsh-snap/install.zsh
fi
source ~/znap-plugins/zsh-snap/znap.zsh

# Autocompletion
if [ ! -d ~/znap-plugins/zsh-autocomplete ]
then
    znap source marlonrichert/zsh-autocomplete
fi
source ~/znap-plugins/zsh-autocomplete/zsh-autocomplete.plugin.zsh


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

# Set prompt to be "[current_branch] [parent_path/current_path]$"
# Here %b is the current branch name, and %F{xxx} ... %f colours the text
# colour xxx, where 170 is the colour "orchid" and 154 the colour
# "GreenYellow". See all colours available here:
# https://jonasjacek.github.io/colors/
zstyle ':vcs_info:git:*' formats '%F{170}[%b]%f '
PROMPT=\$vcs_info_msg_0_
PROMPT+='%F{154}%2~$ %f'


#=============================
# Set up general ZSH settings
# ============================

# Enable vi mode
bindkey -v

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


#==================================
# Set up general terminal settings
#==================================

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

# Ensure openblas has been set up, which is used for Numpy to work
export OPENBLAS="$(brew --prefix openblas)"

# Enable MPS fallback
export PYTORCH_ENABLE_MPS_FALLBACK="1"

# NVM directory
export NVM_DIR="$HOME/.config/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion


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
alias bb='/Applications/Brave\ Browser.app/Contents/MacOS/Brave\ Browser'
alias ll='ls -l'
alias la='ls -ah'
alias lla='ls -lah'
alias gs='git status --short'
alias ga='git add'
alias gd='git diff'
alias gb='git branches'
alias gc='git checkout'
alias gl='git log --graph --pretty=format:"%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset" --abbrev-commit --date=relative'
alias tcc='tmux -CC'
alias python='python3'
alias code='open -a "Visual Studio Code"'


#=========
# Secret environment variables
#=========

# Load secret environment variables from .env
if [ -f ~/.env ]
then
    export $(cat ~/.env | xargs)
fi


#============
# Misc setup
#============

fpath+=~/.zfunc; autoload -Uz compinit; compinit
